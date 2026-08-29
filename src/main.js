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
const PRICING_TTL_MS = 24 * 60 * 60 * 1000;
const PRICING_URLS = [
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
  'https://models.dev/api.json',
];

let tray = null;
let win = null;
let quitting = false;
let refreshing = false;
let lastError = null;
let snapshot = null;
let ccusageBin = null;
let codexQuota = null;
let pricingCacheRefreshing = false;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const pad = (n) => String(n).padStart(2, '0');
const localDateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localMonthStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

function executableExists(bin) {
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return fs.statSync(bin).isFile();
  } catch {
    return false;
  }
}

// Bare names must be resolved against PATH ourselves: execFile's lookup uses
// the inherited env, and under GNOME autostart nvm/volta/etc are never loaded.
function whichOnPath(name) {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const full = path.join(dir, name);
    if (executableExists(full)) return full;
  }
  return null;
}

// Autostart sessions don't source ~/.nvm/nvm.sh, so nvm-installed ccusage is
// invisible on PATH after a reboot. Scan known version managers explicitly.
function versionManagerCandidates(home) {
  const out = [];
  const scans = [
    path.join(home, '.nvm', 'versions', 'node'),
    path.join(home, '.volta', 'tools', 'image', 'node'),
    path.join(home, '.local', 'share', 'mise', 'installs', 'node'),
  ];
  const verKey = (v) => v.split(/[.\-]/).map((n) => parseInt(n, 10) || 0);
  for (const base of scans) {
    try {
      const versions = fs
        .readdirSync(base)
        .sort((a, b) => {
          const ka = verKey(a);
          const kb = verKey(b);
          for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
            const d = (ka[i] || 0) - (kb[i] || 0);
            if (d) return -d; // newest first
          }
          return 0;
        });
      for (const v of versions) out.push(path.join(base, v, 'bin', 'ccusage'));
    } catch {
      /* manager not installed */
    }
  }
  return out;
}

// Preferred source: the ccusage npm package bundled with this app
// (package.json dependency). Resolved via its package.json `bin` field so
// version layout changes don't break us.
function findBundledCcusage() {
  try {
    const pkgPath = require.resolve('ccusage/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.ccusage;
    if (!rel) return null;
    const cli = path.join(path.dirname(pkgPath), rel);
    return executableExists(cli) ? cli : null;
  } catch {
    return null;
  }
}

function findCcusage() {
  const home = process.env.HOME || '';
  const candidates = [
    process.env.CCUSAGE_BIN,
    `${home}/.bun/bin/ccusage`,
    `${home}/.npm-global/bin/ccusage`,
    ...versionManagerCandidates(home),
  ].filter(Boolean);

  for (const c of candidates) {
    if (c.includes('/') ? executableExists(c) : false) return c;
  }

  // Last resort: whatever is on PATH right now (works for interactive runs).
  return whichOnPath('ccusage') || 'ccusage';
}

function resolveCcusage() {
  const bundled = !process.env.CCUSAGE_BIN && findBundledCcusage();
  if (bundled) return { bundled: true, cli: bundled };
  return { bundled: false, bin: findCcusage() };
}

async function runCcusage(args, { offline = false } = {}) {
  // Bundled CLI is spawned through Electron's own Node runtime
  // (ELECTRON_RUN_AS_NODE), so no system Node.js is required at all.
  const finalArgs = offline ? [...args, '--offline'] : args;
  const target = ccusageBin ||= resolveCcusage();
  const opts = {
    maxBuffer: 128 * 1024 * 1024,
    timeout: 120_000,
    encoding: 'utf8',
  };
  try {
    const { stdout } = target.bundled
      ? await execFileP(process.execPath, [target.cli, ...finalArgs], {
          ...opts,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        })
      : await execFileP(target.bin, finalArgs, opts);
    return JSON.parse(stdout);
  } catch (err) {
    // Resolver went stale (dep removed/upgraded): re-resolve next tick.
    if (err?.code === 'ENOENT') ccusageBin = null;
    throw err;
  }
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
    pricingCache: loadPricingCache(),
    error: lastError,
  };
}

async function refresh(broadcast = true) {
  if (refreshing) return snapshot;
  refreshing = true;
  updateTray();
  try {
    const offline = isPricingCacheFresh();
    if (offline) console.log('[pricing] using cached pricing (--offline)');
    else console.log('[pricing] cache stale/missing — fetching live pricing');

    const [dailyJson, monthlyJson] = await Promise.all([
      runCcusage(['daily', '--json', '--by-agent', '--breakdown'], { offline }),
      runCcusage(['monthly', '--json', '--by-agent', '--breakdown'], { offline }),
    ]);
    // On a successful live fetch, mark pricing cache fresh so next 24h uses --offline.
    // On offline runs we keep the existing timestamp; staleness is checked lazily.
    if (!offline) {
      try {
        // Persist the fact that pricing was just fetched live via ccusage
        touchPricingCache();
      } catch {}
      // Also refresh the on-disk pricing JSON in background (best-effort, never blocks UI)
      refreshPricingCacheInBackground();
    }
    // Quota is best-effort: never block or fail usage data on it.
    await refreshQuota();
    snapshot = buildSnapshot(parseRows(dailyJson, 'daily'), parseRows(monthlyJson, 'monthly'));
    lastError = null;
    saveSnapshotCache(snapshot);
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

/* ------------------------- snapshot disk cache ---------------------------- */
// ccusage rescans every session log on each run, which is slow right after a
// cold boot. Persist the last good snapshot so boot shows data instantly and
// revalidates in the background (stale-while-revalidate).

function snapshotCachePath() {
  return path.join(app.getPath('userData'), 'snapshot-cache.json');
}

function loadSnapshotCache() {
  try {
    const snap = JSON.parse(fs.readFileSync(snapshotCachePath(), 'utf8'));
    if (!snap || typeof snap !== 'object' || !Number.isFinite(snap.updatedAt)) return null;
    if (!Array.isArray(snap.daily) || !Array.isArray(snap.monthly)) return null;
    return snap;
  } catch {
    return null;
  }
}

function saveSnapshotCache(snap) {
  if (!snap) return;
  try {
    fs.writeFileSync(snapshotCachePath(), JSON.stringify(snap));
  } catch (err) {
    console.error('[cache] write failed:', err?.message || err);
  }
}

/* ------------------------- pricing disk cache ---------------------------- */
// ccusage fetches model pricing from LiteLLM / models.dev on every invocation
// (6s network fetch). Cache the fact that pricing was fetched and the raw
// pricing JSON itself to disk for 24h, then use `--offline` (embedded + cached
// snapshot) for all intermediate refreshes. On startup and every 24h we do a
// single live fetch to refresh the snapshot.

function pricingCachePath() {
  return path.join(app.getPath('userData'), 'pricing-cache.json');
}

function loadPricingCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(pricingCachePath(), 'utf8'));
    if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.fetchedAt)) return null;
    return raw;
  } catch {
    return null;
  }
}

function isPricingCacheFresh() {
  const c = loadPricingCache();
  if (!c) return false;
  return Date.now() - c.fetchedAt < PRICING_TTL_MS;
}

function touchPricingCache() {
  const now = Date.now();
  let prev = null;
  try {
    prev = loadPricingCache();
  } catch {}
  const payload = {
    fetchedAt: now,
    ttlMs: PRICING_TTL_MS,
    sources: PRICING_URLS,
    // Preserve previously fetched raw data if present; avoid losing it on a pure timestamp bump
    liteLLM: prev?.liteLLM ?? null,
    modelsDev: prev?.modelsDev ?? null,
    errors: prev?.errors ?? [],
  };
  const tmp = pricingCachePath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, pricingCachePath());
  console.log(`[pricing] marked fresh at ${new Date(now).toISOString()}`);
}

async function fetchAndCachePricing() {
  if (pricingCacheRefreshing) return null;
  pricingCacheRefreshing = true;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    console.log('[pricing] fetching live pricing from LiteLLM / models.dev ...');
    const fetches = PRICING_URLS.map((url) =>
      fetch(url, {
        signal: ac.signal,
        headers: { 'User-Agent': 'agent-menubar/pricing-cache', Accept: 'application/json' },
      }).then(async (res) => {
        if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
        return res.json();
      }),
    );
    const results = await Promise.allSettled(fetches);
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    if (succeeded.length === 0) {
      const reasons = results.map((r) => (r.status === 'rejected' ? String(r.reason).slice(0, 120) : '')).join(' | ');
      throw new Error(`all pricing fetches failed: ${reasons}`);
    }
    const payload = {
      fetchedAt: Date.now(),
      ttlMs: PRICING_TTL_MS,
      sources: PRICING_URLS,
      liteLLM: results[0].status === 'fulfilled' ? results[0].value : null,
      modelsDev: results[1].status === 'fulfilled' ? results[1].value : null,
      errors: results
        .filter((r) => r.status === 'rejected')
        .map((r) => String(r.reason).slice(0, 160)),
    };
    const tmp = pricingCachePath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, pricingCachePath());
    console.log(`[pricing] saved ${succeeded.length}/2 sources, ${fs.statSync(pricingCachePath()).size} bytes`);
    return payload;
  } catch (err) {
    console.warn('[pricing] fetch failed:', err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
    pricingCacheRefreshing = false;
  }
}

function refreshPricingCacheInBackground() {
  // Fire-and-forget: never block UI/refresh, just update the on-disk JSON for future `--offline` runs
  fetchAndCachePricing().catch(() => {});
}

async function ensurePricingCacheAtStartup() {
  if (isPricingCacheFresh()) {
    console.log('[pricing] cache fresh at startup, using --offline for next 24h');
    return;
  }
  console.log('[pricing] cache stale/missing at startup — fetching pricing ...');
  const res = await fetchAndCachePricing();
  if (!res) {
    // Even if fetch fails, touch the cache with a short backoff so we don't hammer on every boot
    // But if we have no cache at all, let the first ccusage run be online (it will touch on success)
    console.log('[pricing] startup fetch failed — first ccusage run will be online');
  }
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

  app.whenReady().then(async () => {
    // Wayland: prefer native wayland when available, fall back gracefully.
    if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') {
      // already appended before ready normally, but harmless
    }

    createWindow();
    createTray();
    // Hydrate from the last good snapshot so tray + dashboard render instantly,
    // then revalidate in the background (first real refresh broadcasts).
    snapshot = loadSnapshotCache();
    updateTray();

    ipcMain.handle('usage:get', () => snapshot);
    ipcMain.handle('app:refresh', async () => {
      await refresh(true);
      return snapshot;
    });
    ipcMain.handle('pricing:get', () => loadPricingCache());
    ipcMain.handle('pricing:refresh', async () => {
      const res = await fetchAndCachePricing();
      return res || loadPricingCache();
    });
    ipcMain.on('win:hide', () => win?.hide());
    ipcMain.on('win:show', () => {
      positionWindow();
      win?.show();
      win?.focus();
    });

    // Pricing: fetch at startup or after 24h, save to disk, and use cached pricing via --offline.
    // Await startup ensure so first data refresh can use --offline if we just warmed the cache.
    try {
      await ensurePricingCacheAtStartup();
    } catch (e) {
      console.warn('[pricing] startup ensure failed:', e?.message || e);
    }
    refresh(true);
    setInterval(() => refresh(true), REFRESH_MS);
    // Safety net: if the machine stays up >24h, ensurePricing logic inside refresh() will
    // flip the next refresh to online. Also re-check hourly in case refresh() is idle.
    setInterval(() => {
      if (!isPricingCacheFresh()) {
        console.log('[pricing] TTL expired — background refresh');
        refreshPricingCacheInBackground();
      }
    }, 60 * 60 * 1000);
  });

  app.on('before-quit', () => (quitting = true));
  app.on('window-all-closed', () => {
    // stay alive in tray
  });
}
