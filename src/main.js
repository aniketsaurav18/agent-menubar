const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// Dev-environment friendly flag: the SUID helper is misconfigured for local
// installs on this machine. NOTE: we deliberately do NOT force native Wayland
// ozone — Electron's StatusNotifierItem tray only registers reliably through
// the default X11/XWayland backend, and XWayland also lets us position the
// popup next to the tray (native Wayland toplevels cannot be positioned).
app.commandLine.appendSwitch('no-sandbox');

const execFileP = promisify(execFile);

const WANTED = ['codex', 'opencode', 'claude'];
const META_LABEL = { codex: 'Codex', opencode: 'OpenCode', claude: 'Claude Code' };
const TRAY_SYM = { codex: '◆', opencode: '●', claude: '✳' };
const REFRESH_MS = 60_000;

let tray = null;
let win = null;
let quitting = false;
let refreshing = false;
let lastError = null;
let snapshot = null;
let ccusageBin = null;
let codexQuota = null;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const pad = (n) => String(n).padStart(2, '0');
const localDateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localMonthStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

function findCcusage() {
  const candidates = [
    process.env.CCUSAGE_BIN,
    'ccusage',
    `${process.env.HOME}/.bun/bin/ccusage`,
    `${process.env.HOME}/.npm-global/bin/ccusage`,
  ].filter(Boolean);
  return candidates[0];
}

async function runCcusage(args) {
  const bin = ccusageBin ||= findCcusage();
  const { stdout } = await execFileP(bin, args, {
    maxBuffer: 128 * 1024 * 1024,
    timeout: 120_000,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

/* --------------------------- codex plan quota ---------------------------- */
// Reimplements the wham usage call (see ~/.local/bin/codex-api) natively:
// auth comes from $CODEX_HOME/auth.json, endpoint is ChatGPT's private
// backend. We only surface how much of each rate-limit window remains.

const CODEX_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function normWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const used = num(w.used_percent);
  return {
    usedPercent: used,
    remainingPercent: Math.max(0, Math.min(100, 100 - used)),
    windowSeconds: w.limit_window_seconds ?? null,
    resetAfterSeconds: w.reset_after_seconds ?? null,
    resetAt: w.reset_at ?? null,
  };
}

async function fetchCodexQuota() {
  const authPath = path.join(
    process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex'),
    'auth.json',
  );
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  const token = auth?.tokens?.access_token;
  const accountId = auth?.tokens?.account_id;
  if (!token || !accountId) throw new Error('codex auth.json missing tokens');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);
  try {
    const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'ChatGPT-Account-ID': accountId,
        originator: 'Codex Desktop',
        Accept: 'application/json',
        'User-Agent': CODEX_UA,
        'oai-language': 'en-US',
      },
    });
    if (!res.ok) throw new Error(`wham/usage HTTP ${res.status}`);
    const data = await res.json();
    const rl = data.rate_limit || {};
    return {
      ok: true,
      fetchedAt: Date.now(),
      planType: data.plan_type || null,
      email: data.email || null,
      allowed: Boolean(rl.allowed),
      limitReached: Boolean(rl.limit_reached),
      primary: normWindow(rl.primary_window),
      secondary: normWindow(rl.secondary_window),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function refreshQuota() {
  try {
    codexQuota = { ...(await fetchCodexQuota()), error: null };
  } catch (err) {
    // keep last good data, flag the error
    codexQuota = {
      ...(codexQuota || {}),
      ok: false,
      fetchedAt: codexQuota?.fetchedAt || Date.now(),
      error: String(err?.message || err).slice(0, 120),
    };
    console.error('[codex-quota]', err?.message || err);
  }
}

function parseBreakdown(entry) {
  const models = (entry?.modelBreakdowns || []).map((m) => ({
    name: String(m?.modelName ?? 'unknown'),
    cost: num(m?.totalCost ?? m?.costUSD ?? m?.cost),
    tokens: num(m?.totalTokens),
  }));
  return {
    cost: num(entry?.totalCost ?? entry?.costUSD),
    tokens: num(entry?.totalTokens),
    inputTokens: num(entry?.inputTokens),
    outputTokens: num(entry?.outputTokens),
    cacheReadTokens: num(entry?.cacheReadTokens),
    cacheCreationTokens: num(entry?.cacheCreationTokens),
    models,
  };
}

// Rows come back mixed across every harness ccusage knows about; we keep only
// the ones we care about and rebuild totals ourselves so other tools never
// leak into the numbers we show.
function parseRows(json, key, periodField) {
  const rows = Array.isArray(json?.[key]) ? json[key] : [];
  const out = [];
  for (const r of rows) {
    const period = r?.[periodField] || r?.period || r?.date || r?.month;
    if (!period) continue;
    const byAgent = {};
    for (const name of WANTED) byAgent[name] = null;
    for (const a of r?.agents || []) {
      const name = String(a?.agent || '').toLowerCase();
      if (!WANTED.includes(name)) continue;
      byAgent[name] = parseBreakdown(a);
    }
    let cost = 0;
    let tokens = 0;
    for (const name of WANTED) {
      if (byAgent[name]) {
        cost += byAgent[name].cost;
        tokens += byAgent[name].tokens;
      }
    }
    out.push({ period, byAgent, cost, tokens });
  }
  out.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
  return out;
}

function buildSnapshot(rawDaily, rawMonthly) {
  const today = localDateStr();
  const thisMonth = localMonthStr();

  const pickPeriod = (rows, p) => rows.find((r) => r.period === p) || null;
  const todayRow = pickPeriod(rawDaily, today);
  const yesterday = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return pickPeriod(rawDaily, localDateStr(d));
  })();
  const monthRow = pickPeriod(rawMonthly, thisMonth);

  // All-time aggregates from monthly history (covers everything ccusage sees).
  const allTime = {
    cost: 0,
    tokens: 0,
    byAgent: {},
    modelsByAgent: {},
    since: rawMonthly.length ? rawMonthly[0].period : null,
  };
  for (const name of WANTED) {
    allTime.byAgent[name] = {
      cost: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    allTime.modelsByAgent[name] = new Map();
  }
  for (const row of rawMonthly) {
    allTime.cost += row.cost;
    allTime.tokens += row.tokens;
    for (const name of WANTED) {
      const part = row.byAgent[name];
      if (!part) continue;
      const agg = allTime.byAgent[name];
      agg.cost += part.cost;
      agg.tokens += part.tokens;
      agg.inputTokens += part.inputTokens || 0;
      agg.outputTokens += part.outputTokens || 0;
      agg.cacheReadTokens += part.cacheReadTokens || 0;
      agg.cacheCreationTokens += part.cacheCreationTokens || 0;
      for (const m of part.models) {
        const cur = allTime.modelsByAgent[name].get(m.name) || { cost: 0, tokens: 0 };
        cur.cost += m.cost;
        cur.tokens += m.tokens;
        allTime.modelsByAgent[name].set(m.name, cur);
      }
    }
  }
  allTime.modelsByAgent = Object.fromEntries(
    Object.entries(allTime.modelsByAgent).map(([k, v]) => [
      k,
      [...v.entries()]
        .map(([name, s]) => ({ name, ...s }))
        .sort((a, b) => b.tokens - a.tokens),
    ]),
  );

  return {
    updatedAt: Date.now(),
    agents: WANTED,
    today: todayRow,
    yesterday,
    month: monthRow,
    daily: rawDaily.slice(-30),
    monthly: rawMonthly.slice(-12),
    allTime,
    codexQuota,
    error: lastError,
  };
}

async function refresh(broadcast = true) {
  if (refreshing) return snapshot;
  refreshing = true;
  updateTray();
  try {
    const [dailyJson, monthlyJson] = await Promise.all([
      runCcusage(['daily', '--json', '--by-agent', '--breakdown']),
      runCcusage(['monthly', '--json', '--by-agent', '--breakdown']),
    ]);
    // Quota is best-effort: never block or fail usage data on it.
    await refreshQuota();
    snapshot = buildSnapshot(parseRows(dailyJson, 'daily'), parseRows(monthlyJson, 'monthly'));
    lastError = null;
  } catch (err) {
    lastError = String(err?.message || err);
    console.error('[ccusage] refresh failed:', lastError);
  } finally {
    refreshing = false;
    updateTray();
    if (broadcast && win && !win.isDestroyed()) {
      win.webContents.send('usage:updated', snapshot);
    }
  }
  return snapshot;
}

/* ---------------------------------- tray ---------------------------------- */

const fmtMoney = (v) =>
  '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtTok(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    positionWindow();
    win.show();
    win.focus();
  }
}

// Drop the panel right under GNOME's top bar, hugging the tray corner.
function positionWindow() {
  try {
    const { workArea } = screen.getPrimaryDisplay();
    const [w] = win.getSize();
    win.setPosition(workArea.x + workArea.width - w - 8, workArea.y + 4);
  } catch {
    /* compositors may ignore positioning; centered fallback is fine */
  }
}

function updateTray() {
  if (!tray) return;
  const s = snapshot;
  const dashLabel = win && win.isVisible() ? 'Hide Dashboard' : 'Open Dashboard';
  const template = [];

  if (!s) {
    template.push({
      label: refreshing ? 'Loading usage…' : 'No data yet',
      enabled: false,
    });
  } else {
    const t = s.today;
    template.push({
      label: `Today  ${fmtMoney(t ? t.cost : 0)} · ${fmtTok(t ? t.tokens : 0)} tok`,
      click: () => {
        positionWindow();
        win.show();
        win.webContents.send('ui:focus-today');
        win.focus();
      },
    });
    for (const name of WANTED) {
      const part = t?.byAgent[name];
      const sym = TRAY_SYM[name] || '●';
      template.push({
        label: `${sym} ${META_LABEL[name]}  ${fmtMoney(part ? part.cost : 0)} · ${fmtTok(part ? part.tokens : 0)}`,
        click: toggleWindow,
      });
    }
    template.push({ type: 'separator' });
    template.push({
      label: `Month  ${fmtMoney(s.month ? s.month.cost : 0)} · ${fmtTok(s.month ? s.month.tokens : 0)} tok`,
      enabled: false,
    });
    template.push({
      label: `All time  ${fmtMoney(s.allTime.cost)} · ${fmtTok(s.allTime.tokens)} tok`,
      enabled: false,
    });
  }

  template.push(
    { type: 'separator' },
    { label: dashLabel, click: toggleWindow },
    {
      label: refreshing ? 'Refreshing…' : 'Refresh Now',
      enabled: !refreshing,
      click: () => refresh(true),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  );

  tray.setContextMenu(Menu.buildFromTemplate(template));
  if (s?.today) {
    tray.setToolTip(`Today ${fmtMoney(s.today.cost)} · ${fmtTok(s.today.tokens)} tok`);
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('Agent Usage');
  updateTray();
  // Some compositors deliver activate/click instead of opening the menu.
  tray.on('click', toggleWindow);
}

/* --------------------------------- window --------------------------------- */

function createWindow() {
  win = new BrowserWindow({
    width: 392,
    height: 620,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  let shownAt = 0;
  win.on('show', () => (shownAt = Date.now()));
  win.on('blur', () => {
    // Grace period so the tray click that opened us doesn't immediately close us.
    if (Date.now() - shownAt > 300) win.hide();
  });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

/* ---------------------------------- boot ---------------------------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    // Wayland: prefer native wayland when available, fall back gracefully.
    if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') {
      // already appended before ready normally, but harmless
    }

    createWindow();
    createTray();
    refresh(false);
    setInterval(() => refresh(true), REFRESH_MS);

    ipcMain.handle('usage:get', () => snapshot);
    ipcMain.handle('app:refresh', async () => {
      await refresh(true);
      return snapshot;
    });
    ipcMain.on('win:hide', () => win?.hide());
    ipcMain.on('win:show', () => {
      positionWindow();
      win?.show();
      win?.focus();
    });
  });

  app.on('before-quit', () => (quitting = true));
  app.on('window-all-closed', () => {
    // stay alive in tray
  });
}
