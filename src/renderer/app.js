/* global api */
'use strict';

const AGENTS = ['codex', 'opencode', 'claude'];
const META = {
  codex: { label: 'Codex', color: '#fb923c' },
  opencode: { label: 'OpenCode', color: '#22d3ee' },
  claude: { label: 'Claude Code', color: '#d97757' },
};

let snap = null;
let tab = 'daily';
let agentFilter = 'all';
let manualBusy = false;

const $ = (sel) => document.querySelector(sel);
const el = {
  updAgo: $('#updAgo'),
  heroCost: $('#heroCost'),
  heroToks: $('#heroToks'),
  spark: $('#sparkWrap'),
  deltaChip: $('#deltaChip'),
  splitTitle: $('#splitTitle'),
  splitPct: $('#splitPct'),
  splitBody: $('#splitBody'),
  view: $('#viewBody'),
  statusDot: $('#statusDot'),
  statusText: $('#statusText'),
  tooltip: $('#tooltip'),
  btnRefresh: $('#btnRefresh'),
  btnClose: $('#btnClose'),
};

const activeAgents = () => (agentFilter === 'all' ? AGENTS : [agentFilter]);

function fmtDuration(sec) {
  if (sec == null || Number.isNaN(Number(sec))) return '—';
  let s = Math.max(0, Math.floor(Number(sec)));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

function renderQuota() {
  const card = $('#quotaCard');
  const q = snap?.codexQuota;
  // The plan/rate-limit bar is Codex-specific: only show it on the Codex tab.
  if (agentFilter !== 'codex' || !q || (!q.primary && !q.secondary && !q.error)) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');

  $('#quotaTitle').textContent = `CODEX PLAN${q.planType ? ` · ${String(q.planType).toUpperCase()}` : ''}`;
  $('#quotaState').textContent = q.error
    ? `unavailable — ${q.error.slice(0, 28)}`
    : q.limitReached
      ? 'limit reached'
      : 'available';

  const body = $('#quotaBody');
  if (q.error && !q.primary && !q.secondary) {
    body.innerHTML = '';
    return;
  }

  const rowHtml = (name, w) => {
    if (!w) return '';
    // remaining drives the bar color: plenty left = green, low = amber/red
    const rem = w.remainingPercent ?? 0;
    const used = w.usedPercent ?? 100 - rem;
    const color = used >= 90 ? '#f87171' : used >= 70 ? '#fbbf24' : '#34d399';
    return `
      <div class="qrow">
        <span class="qname">${name}</span>
        <span class="qval"><b style="color:${color}">${rem.toFixed(0)}% left</b> · resets in ${fmtDuration(w.resetAfterSeconds)}</span>
      </div>
      <div class="qtrack"><div class="qfill" style="width:${rem}%;background:${color}"></div></div>`;
  };

  body.innerHTML =
    rowHtml('PRIMARY WINDOW', q.primary) +
    rowHtml('SECONDARY WINDOW', q.secondary);
}

function filtRows(rows) {
  if (agentFilter === 'all') return rows;
  return rows.map((r) => {
    const p = r.byAgent?.[agentFilter];
    return { period: r.period, cost: p ? p.cost : 0, tokens: p ? p.tokens : 0, byAgent: { [agentFilter]: p } };
  });
}

/* ------------------------------ formatting ------------------------------ */

const fmtMoney = (v, opts = {}) =>
  '$' + (v ?? 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    ...opts,
  });

function fmtTok(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function ago(ts) {
  if (!ts) return '…';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function localDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function localMonthStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
}

function monthRowFor(period) {
  return (snap?.monthly || []).find((r) => r.period === period) || null;
}

function monthTitle(period) {
  const [y, m] = period.split('-').map(Number);
  return `${MONTHS[m - 1].toUpperCase()} ${y}`;
}

function dateLabel(period) {
  const d = new Date(period + 'T12:00:00');
  const today = localDateStr();
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (period === today) return { d1: 'Today', d2: period };
  if (period === localDateStr(y)) return { d1: 'Yesterday', d2: period };
  return { d1: `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`, d2: period };
}

function monthLabel(period) {
  const [y, m] = period.split('-').map(Number);
  return { d1: `${MONTHS[m - 1]} ${y}`, d2: period };
}

/* ------------------------------- tooltip -------------------------------- */

function showTip(html, x, y) {
  el.tooltip.innerHTML = html;
  el.tooltip.classList.remove('hidden');
  const r = el.tooltip.getBoundingClientRect();
  let tx = x + 14;
  let ty = y - r.height - 10;
  if (tx + r.width > window.innerWidth - 8) tx = x - r.width - 14;
  if (ty < 8) ty = y + 16;
  el.tooltip.style.left = `${tx}px`;
  el.tooltip.style.top = `${ty}px`;
}
const hideTip = () => el.tooltip.classList.add('hidden');

function tipHtml(title, row) {
  const lines = activeAgents().map((a) => {
    const p = row?.byAgent?.[a];
    return `<div class="tt-line"><span class="rdot ${a}"></span>${META[a].label}&nbsp; <b>${
      p ? fmtMoney(p.cost) : '$0.00'
    }</b> · ${fmtTok(p ? p.tokens : 0)} tok</div>`;
  }).join('');
  return `<div class="tt-title">${title}</div>${lines}<div class="tt-line">Total&nbsp; <b>${fmtMoney(
    row ? row.cost : 0,
  )}</b> · ${fmtTok(row ? row.tokens : 0)} tok</div>`;
}

/* --------------------------------- hero --------------------------------- */

// Totals for the active agent filter, extracted from a period row.
function tfAgg(row) {
  if (!row) return null;
  if (agentFilter === 'all') return { cost: row.cost, tokens: row.tokens };
  const p = row.byAgent?.[agentFilter];
  return p ? { cost: p.cost, tokens: p.tokens } : null;
}

// Current + comparison-period totals for whichever time frame tab is active.
function timeframeTotals() {
  if (tab === 'monthly') {
    const prevD = new Date();
    prevD.setDate(1);
    prevD.setMonth(prevD.getMonth() - 1);
    return {
      cur: tfAgg(monthRowFor(localMonthStr())),
      prev: tfAgg(monthRowFor(localMonthStr(prevD))),
    };
  }
  if (tab === 'alltime') {
    const at = snap?.allTime;
    const s = at && (agentFilter === 'all' ? at : at.byAgent?.[agentFilter]);
    return { cur: s ? { cost: s.cost || 0, tokens: s.tokens || 0 } : null, prev: null };
  }
  return { cur: tfAgg(snap?.today), prev: tfAgg(snap?.yesterday) };
}

const HERO_LBL = {
  daily: ['SPEND TODAY', 'TOKENS TODAY'],
  monthly: ['SPEND THIS MONTH', 'TOKENS THIS MONTH'],
  alltime: ['TOTAL SPEND', 'TOTAL TOKENS'],
};

function renderHero() {
  const f = agentFilter;
  const { cur, prev } = timeframeTotals();

  const suffix = f === 'all' ? '' : ` · ${META[f].label.toUpperCase()}`;
  const [costLbl, tokLbl] = HERO_LBL[tab];
  $('#heroCostLbl').textContent = costLbl + suffix;
  $('#heroToksLbl').textContent = tokLbl + suffix;
  el.heroCost.textContent = fmtMoney(cur ? cur.cost : 0);
  el.heroToks.textContent = fmtTok(cur ? cur.tokens : 0);

  // delta vs the comparable previous period (none exists for all-time)
  const chip = el.deltaChip;
  const cmpLbl = tab === 'monthly' ? 'vs last mo' : 'vs yday';
  if (tab === 'alltime' || (!cur && !prev)) {
    chip.classList.add('hidden');
  } else {
    chip.classList.remove('hidden');
    const tc = cur ? cur.cost : 0;
    const yc = prev ? prev.cost : 0;
    if (!prev || yc === 0) {
      chip.className = 'chip flat';
      chip.textContent = prev
        ? `${cmpLbl} —`
        : tab === 'monthly' ? 'first spend month' : 'first spend day';
    } else {
      const diff = ((tc - yc) / yc) * 100;
      if (Math.abs(diff) < 0.5) {
        chip.className = 'chip flat';
        chip.textContent = `±0% ${cmpLbl}`;
      } else {
        chip.className = 'chip ' + (diff > 0 ? 'up' : 'down');
        chip.textContent = `${diff > 0 ? '+' : ''}${diff.toFixed(0)}% ${cmpLbl}`;
      }
    }
  }

  renderSpark();
}

function sparkRows() {
  if (tab === 'daily') return filtRows(snap?.daily || []).slice(-7);
  return filtRows(snap?.monthly || []).slice(tab === 'monthly' ? -6 : -12);
}

function renderSpark() {
  const rows = sparkRows();
  $('#sparkLbl').textContent =
    tab === 'daily' ? 'LAST 7 DAYS' : tab === 'monthly' ? 'LAST 6 MONTHS' : 'MONTHLY TREND';
  const wrap = el.spark;
  if (!rows.length) {
    wrap.innerHTML = '';
    return;
  }
  // Render at the container's true pixel size so the line and end dot are
  // never stretched, and scale y to max*1.2 for headroom above the curve.
  const W = Math.max(wrap.clientWidth, 60);
  const H = Math.max(wrap.clientHeight || 30, 20);
  const PAD = 4;
  const max = Math.max(...rows.map((r) => r.cost), 1e-9) * 1.2;
  const pts = rows.map((r, i) => {
    const x = PAD + (i / Math.max(rows.length - 1, 1)) * (W - PAD * 2);
    const y = H - PAD - (r.cost / max) * (H - PAD * 2);
    return [x, y];
  });
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = `${path} L${pts[pts.length - 1][0].toFixed(1)} ${H} L${pts[0][0].toFixed(1)} ${H} Z`;
  const [lx, ly] = pts[pts.length - 1];
  wrap.innerHTML = `
    <svg viewBox="0 0 ${W.toFixed(0)} ${H}" width="${W.toFixed(0)}" height="${H}" preserveAspectRatio="none" style="display:block;width:100%;height:100%">
      <path d="${area}" fill="rgba(34,211,238,.12)"/>
      <path d="${path}" fill="none" stroke="#22d3ee" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.4" fill="#67e8f9"/>
    </svg>`;
}

/* ----------------------------- split today ------------------------------ */

// The row backing the split card for the active time frame. All-time has no
// single row, so we assemble one from the aggregate + per-agent model lists.
function splitSourceRow() {
  if (tab === 'monthly') return monthRowFor(localMonthStr());
  if (tab === 'alltime') {
    const at = snap?.allTime;
    if (!at) return null;
    return {
      cost: at.cost,
      tokens: at.tokens,
      byAgent: Object.fromEntries(
        AGENTS.map((a) => [
          a,
          at.byAgent?.[a]
            ? { ...at.byAgent[a], models: at.modelsByAgent?.[a] || [] }
            : null,
        ]),
      ),
    };
  }
  return snap?.today;
}

const SPLIT_EMPTY = {
  daily: 'no tokens spent today',
  monthly: 'no tokens spent this month',
  alltime: 'no tokens spent yet',
};

function renderSplit() {
  const t = splitSourceRow();
  const titleBase =
    tab === 'monthly' ? `SPLIT · ${monthTitle(localMonthStr())}`
      : tab === 'alltime' ? 'ALL-TIME SPLIT'
        : 'SPLIT TODAY';

  if (agentFilter !== 'all') {
    const p = t?.byAgent?.[agentFilter];
    el.splitTitle.textContent = `${titleBase} · ${META[agentFilter].label.toUpperCase()}`;
    el.splitPct.textContent = p ? `${fmtTok(p.tokens)} tok` : 'no usage yet';
    const models = (p?.models || []).filter((m) => m.tokens > 0 || m.cost > 0);
    if (models.length) {
      el.splitBody.innerHTML = `<div class="models">${models
        .map(
          (m) =>
            `<span class="model-chip"><b>${m.name}</b>&nbsp; ${fmtMoney(m.cost)} · ${fmtTok(m.tokens)}</span>`,
        )
        .join('')}</div>`;
    } else if (p && (p.tokens > 0 || p.cost > 0)) {
      // period has spend but no per-model breakdown available
      el.splitBody.innerHTML =
        `<div class="split-empty">${fmtMoney(p.cost)} · ${fmtTok(p.tokens)} tok spent</div>`;
    } else {
      el.splitBody.innerHTML = `<div class="split-empty">${SPLIT_EMPTY[tab]}</div>`;
    }
    return;
  }

  el.splitTitle.textContent = titleBase;
  const parts = {};
  let total = 0;
  for (const a of AGENTS) {
    parts[a] = t?.byAgent?.[a]?.cost || 0;
    total += parts[a];
  }
  const sum = (k) => AGENTS.reduce((acc, a) => acc + ((t?.byAgent?.[a]?.[k]) || 0), 0);

  el.splitBody.innerHTML = `
    <div class="split-bar">${AGENTS.map((a) => {
      const pct = total > 0 ? (parts[a] / total) * 100 : 100 / AGENTS.length;
      const cls = total > 0 ? a : 'none';
      return `<div class="seg ${cls}" style="width:${pct}%"></div>`;
    }).join('')}</div>
    <div class="legend">${AGENTS.map((a) => {
      const pct = total > 0 ? ((parts[a] / total) * 100).toFixed(0) : (100 / AGENTS.length).toFixed(0);
      return `<span class="leg"><span class="swatch" style="background:${META[a].color}"></span>${
        META[a].label
      }&nbsp;<b>${fmtMoney(parts[a])}</b> · ${pct}%</span>`;
    }).join('')}</div>`;
  el.splitPct.textContent = total > 0 ? `${fmtTok(sum('tokens'))} tok` : 'no usage yet';
}

/* -------------------------------- charts -------------------------------- */

function chartCard(rows, labelFor, title) {
  const recent = rows.slice(-14);
  const max = Math.max(...recent.map((r) => r.cost), 1e-9);
  const agents = activeAgents();
  const cols = recent
    .map((r, i) => {
      const segs = agents.map((a) => {
        const c = r.byAgent?.[a]?.cost || 0;
        if (c <= 0) return '';
        const h = Math.max((c / max) * 96, 2);
        return `<div class="seg-v ${a}" style="height:${h.toFixed(1)}px"></div>`;
      }).join('');
      const inner =
        r.cost > 0
          ? segs
          : `<div class="zero"></div>`;
      return `<div class="col" data-i="${i}">${inner}</div>`;
    })
    .join('');

  const l0 = labelFor(recent[0].period).d1.split(',')[0];
  const ln = labelFor(recent[recent.length - 1].period).d1;

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-head">
      <span class="card-title">${title}</span>
      <span class="card-sub">${fmtMoney(recent.reduce((s, r) => s + r.cost, 0))} total</span>
    </div>
    <div class="chart">${cols}</div>
    <div class="x-labels"><span>${l0}</span><span>${ln}</span></div>`;

  card.querySelectorAll('.col').forEach((colEl) => {
    const row = recent[Number(colEl.dataset.i)];
    const move = (e) => showTip(tipHtml(labelFor(row.period).d1, row), e.clientX, e.clientY);
    colEl.addEventListener('mouseenter', move);
    colEl.addEventListener('mousemove', move);
    colEl.addEventListener('mouseleave', hideTip);
  });
  return card;
}

function listCard(rows, labelFor, limit = 30) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<div class="card-head">
      <span class="card-title">HISTORY</span>
      <span class="card-sub">${rows.length} entries</span>
    </div>`;
  const frag = document.createDocumentFragment();
  for (const r of [...rows].reverse().slice(0, limit)) {
    const lbl = labelFor(r.period);
    const agents = activeAgents();
    const segs = agents.map((a) => {
      const c = r.byAgent?.[a]?.cost || 0;
      if (r.cost <= 0 || c <= 0) return '';
      return `<div class="mini-seg ${a}" style="width:${((c / r.cost) * 100).toFixed(1)}%"></div>`;
    }).join('');
    const agentsBits = agents.map((a) => {
      const p = r.byAgent?.[a];
      return `<span><span class="rdot ${a}"></span>${fmtMoney(p ? p.cost : 0)}</span>`;
    }).join('');
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    rowEl.innerHTML = `
      <div class="row-date"><div class="d1">${lbl.d1}</div><div class="d2">${lbl.d2}</div></div>
      <div class="row-mid">
        <div class="mini-track">${segs || '<div class="mini-seg" style="width:0"></div>'}</div>
        <div class="row-agents">${agentsBits}</div>
      </div>
      <div class="row-total ${r.cost > 0 ? '' : 'zero'}">${fmtMoney(r.cost)}</div>`;
    frag.appendChild(rowEl);
  }
  card.appendChild(frag);
  return card;
}

/* ------------------------------- all-time ------------------------------- */

function donutSvg(byAgent, totalCost, agents) {
  const list = agents || AGENTS;
  const R = 19, C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = list.map((a) => {
    const frac = totalCost > 0 ? (byAgent[a]?.cost || 0) / totalCost : 1 / list.length;
    const arc = `<circle cx="24" cy="24" r="${R}" fill="none"
       stroke="${META[a].color}" stroke-width="7"
       stroke-dasharray="${(frac * C - 2).toFixed(2)} ${(C - frac * C + 2).toFixed(2)}"
       stroke-dashoffset="${(-offset * C).toFixed(2)}"
       transform="rotate(-90 24 24)" stroke-linecap="butt"/>`;
    offset += frac;
    return arc;
  }).join('');
  return `<svg viewBox="0 0 48 48" width="76" height="76">
    <circle cx="24" cy="24" r="${R}" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="7"/>${arcs}</svg>`;
}

const TOK_KINDS = [
  ['inputTokens', 'input', '#60a5fa'],
  ['outputTokens', 'output', '#f472b6'],
  ['cacheReadTokens', 'cache read', '#34d399'],
  ['cacheCreationTokens', 'cache write', '#fbbf24'],
];

function tokenSplitHtml(s) {
  const total = TOK_KINDS.reduce((acc, [k]) => acc + (s?.[k] || 0), 0);
  if (!total) return '';
  return `
    <div class="tokbar">${TOK_KINDS.map(([k, , color]) => {
      const v = s[k] || 0;
      if (v <= 0) return '';
      return `<div style="width:${((v / total) * 100).toFixed(1)}%;background:${color}"></div>`;
    }).join('')}</div>
    <div class="toklegend">${TOK_KINDS.map(([k, label, color]) => {
      const v = s?.[k] || 0;
      return `<span><span class="tdot" style="background:${color}"></span>${label}&nbsp;<b>${fmtTok(v)}</b></span>`;
    }).join('')}</div>`;
}

function allTimeView() {
  const at = snap.allTime;
  const wrap = document.createDocumentFragment();
  const single = agentFilter !== 'all';
  const agents = activeAgents();

  const bannerCost = single ? (at.byAgent[agentFilter]?.cost || 0) : at.cost;
  const bannerToks = single ? (at.byAgent[agentFilter]?.tokens || 0) : at.tokens;
  const sinceLbl = single ? ` · ${META[agentFilter].label.toUpperCase()}` : '';

  const grand = document.createElement('div');
  grand.className = 'grand';
  grand.innerHTML = `
    <div class="grand-info">
      <span class="lbl">ALL TIME${sinceLbl}${at.since ? ` · SINCE ${at.since}` : ''}</span>
      <div class="grand-stats">
        <div>
          <span class="stat-mid">${fmtMoney(bannerCost)}</span>
          <span class="grand-sub-lbl">SPEND</span>
        </div>
        <div>
          <span class="stat-mid muted">${fmtTok(bannerToks)}</span>
          <span class="grand-sub-lbl">TOKENS</span>
        </div>
      </div>
    </div>
    ${single ? '' : donutSvg(at.byAgent, at.cost, agents)}`;
  wrap.appendChild(grand);

  for (const a of agents) {
    const s = at.byAgent[a] || { cost: 0, tokens: 0 };
    const share = at.cost > 0 ? (((s.cost || 0) / at.cost) * 100).toFixed(1) : '0.0';
    const models = (at.modelsByAgent?.[a] || []).slice(0, single ? 8 : 5);
    const card = document.createElement('div');
    card.className = 'card agent-card';
    card.innerHTML = `
      <div class="agent-head">
        <span class="dot-${a}"></span>
        <span class="agent-name">${META[a].label}</span>
        <span class="agent-share">${share}% of spend</span>
      </div>
      <div class="agent-cost-row">
        <span class="agent-cost">${fmtMoney(s.cost)}</span>
        <span class="agent-toks">${fmtTok(s.tokens)} <span class="unit">tok</span></span>
      </div>
      ${tokenSplitHtml(s)}
      ${
        models.length
          ? `<div class="models">${models
              .map(
                (m) =>
                  `<span class="model-chip"><b>${m.name}</b>&nbsp; ${fmtTok(m.tokens)}</span>`,
              )
              .join('')}</div>`
          : ''
      }`;
    wrap.appendChild(card);
  }
  return wrap;
}

/* --------------------------------- views --------------------------------- */

function renderView() {
  el.view.replaceChildren();
  if (!snap) return skeleton();

  if (!snap.daily.length && !snap.monthly.length) {
    el.view.innerHTML = `<div class="empty"><div class="big">◌</div>
      <p>No usage found yet.<br/>ccusage hasn't seen any sessions for<br/><b>codex</b>, <b>opencode</b> or <b>claude code</b>.</p></div>`;
    return;
  }

  if (tab === 'daily') {
    const rows = filtRows(snap.daily);
    const suffix = agentFilter === 'all' ? '' : ` · ${META[agentFilter].label.toUpperCase()}`;
    el.view.append(chartCard(rows, dateLabel, `DAILY SPEND · LAST 14 DAYS${suffix}`));
    el.view.append(listCard(rows, dateLabel));
  } else if (tab === 'monthly') {
    const rows = filtRows(snap.monthly);
    el.view.append(chartCard(rows, monthLabel, 'MONTHLY SPEND'));
    el.view.append(listCard(rows, monthLabel));
  } else {
    el.view.append(allTimeView());
  }
}

function skeleton() {
  const mk = (h) => {
    const d = document.createElement('div');
    d.className = 'skel';
    d.style.height = h + 'px';
    d.style.marginBottom = '8px';
    return d;
  };
  el.view.append(mk(120), mk(64), mk(64), mk(64));
}

/* -------------------------------- status --------------------------------- */

function renderStatus() {
  if (manualBusy) {
    el.statusDot.className = 'dot loading';
    el.statusText.textContent = 'refreshing…';
    el.btnRefresh.classList.add('spinning');
    return;
  }
  el.btnRefresh.classList.remove('spinning');
  if (snap?.error) {
    el.statusDot.className = 'dot error';
    el.statusText.textContent = `error: ${snap.error.slice(0, 42)}`;
  } else if (!snap) {
    el.statusDot.className = 'dot loading';
    el.statusText.textContent = 'loading usage…';
  } else {
    el.statusDot.className = 'dot live';
    el.statusText.textContent = 'live · auto-refresh 60s';
  }
}

function renderAll() {
  renderQuota();
  renderHero();
  renderSplit();
  renderView();
  renderStatus();
  tickAgo();
}

function tickAgo() {
  el.updAgo.textContent = snap ? ago(snap.updatedAt) : '';
}

setInterval(() => {
  tickAgo();
  if (snap && !manualBusy && Date.now() - snap.updatedAt > 90_000) renderStatus();
}, 1000);

/* -------------------------------- events --------------------------------- */

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => setTab(btn.dataset.tab));
});

function setTab(t) {
  tab = t;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  // Hero, sparkline and split card all follow the selected time frame.
  renderHero();
  renderSplit();
  renderView();
}

const AGENT_ORDER = ['all', 'codex', 'opencode', 'claude'];

function setAgent(a) {
  agentFilter = a;
  document.querySelectorAll('.anav').forEach((b) =>
    b.classList.toggle('active', b.dataset.agent === a),
  );
  renderQuota(); // codex plan bar only lives on the codex tab
  renderHero();
  renderSplit();
  renderView();
}

document.querySelectorAll('.anav').forEach((btn) => {
  btn.addEventListener('click', () => setAgent(btn.dataset.agent));
});

el.btnClose.addEventListener('click', () => window.api?.hide());
el.btnRefresh.addEventListener('click', doRefresh);

async function doRefresh() {
  if (!window.api || manualBusy) return;
  manualBusy = true;
  renderStatus();
  try {
    await window.api.refresh();
  } finally {
    manualBusy = false;
    renderStatus();
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api?.hide();
  else if (e.key === 'r' || e.key === 'R') doRefresh();
  else if (e.key === '1') setTab('daily');
  else if (e.key === '2') setTab('monthly');
  else if (e.key === '3') setTab('alltime');
  else if (e.key === 'a' || e.key === 'A') {
    const next = AGENT_ORDER[(AGENT_ORDER.indexOf(agentFilter) + 1) % AGENT_ORDER.length];
    setAgent(next);
  }
});

window.addEventListener('blur', hideTip);

/* ---------------------------------- boot ---------------------------------- */

if (window.api) {
  window.api.getUsage().then((s) => {
    if (s) snap = s;
    renderAll();
  });
  window.api.onUpdate((s) => {
    if (s) snap = s;
    renderAll();
  });
  window.api.refresh();
} else {
  snap = mockSnapshot(); // browser preview mode
  renderAll();
}

/* ------------------------- mock data (preview only) ----------------------- */

function mockSnapshot() {
  const pad = (n) => String(n).padStart(2, '0');
  const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = new Date();
  const rnd = (a, b) => a + Math.random() * (b - a);

  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const skip = Math.random() < 0.18;
    const cx = skip ? 0 : rnd(0, 14);
    const oc = skip ? 0 : rnd(0, 4);
    const cl = skip ? 0 : rnd(0, 6);
    daily.push({
      period: dstr(d),
      cost: cx + oc + cl,
      tokens: (cx + oc + cl) * 48000,
      byAgent: {
        codex: {
          cost: cx,
          tokens: cx * 52000,
          models: [{ name: 'gpt-5.6-sol', cost: cx, tokens: cx * 52000 }],
        },
        opencode: {
          cost: oc,
          tokens: oc * 38000,
          models: [
            { name: 'x-preview-f-free', cost: oc * 0.7, tokens: oc * 26000 },
            { name: 'kimi-k2.5-free', cost: oc * 0.3, tokens: oc * 12000 },
          ],
        },
        claude: {
          cost: cl,
          tokens: cl * 30000,
          models: [{ name: 'claude-opus-4-6', cost: cl, tokens: cl * 30000 }],
        },
      },
    });
  }

  const monthly = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const cx = rnd(40, 260);
    const oc = rnd(5, 40);
    const cl = rnd(10, 90);
    monthly.push({
      period: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
      cost: cx + oc + cl,
      tokens: (cx + oc + cl) * 52000,
      byAgent: {
        codex: {
          cost: cx,
          tokens: cx * 55000,
          models: [{ name: 'gpt-5.6-sol', cost: cx, tokens: cx * 55000 }],
        },
        opencode: {
          cost: oc,
          tokens: oc * 40000,
          models: [{ name: 'kimi-k2.5-free', cost: oc, tokens: oc * 40000 }],
        },
        claude: {
          cost: cl,
          tokens: cl * 32000,
          models: [{ name: 'claude-opus-4-6', cost: cl, tokens: cl * 32000 }],
        },
      },
    });
  }

  const tRow = daily[daily.length - 1];
  const thisMonth = monthly[monthly.length - 1];
  const allTime = monthly.reduce(
    (acc, m) => {
      acc.cost += m.cost;
      acc.tokens += m.tokens;
      for (const a of AGENTS) {
        acc.byAgent[a].cost += m.byAgent[a].cost;
        acc.byAgent[a].tokens += m.byAgent[a].tokens;
      }
      return acc;
    },
    {
      cost: 0,
      tokens: 0,
      byAgent: {
        codex: { cost: 0, tokens: 0 },
        opencode: { cost: 0, tokens: 0 },
        claude: { cost: 0, tokens: 0 },
      },
      since: monthly[0].period,
    },
  );
  allTime.modelsByAgent = {
    codex: [
      { name: 'gpt-5.6-sol', tokens: 61_200_000, cost: allTime.byAgent.codex.cost },
      { name: 'gpt-5.2', tokens: 12_400_000, cost: 31.2 },
    ],
    opencode: [
      { name: 'x-preview-f-free', tokens: 48_900_000, cost: 0 },
      { name: 'kimi-k2.5-free', tokens: 9_100_000, cost: 12.4 },
    ],
    claude: [
      { name: 'claude-opus-4-6', tokens: 28_400_000, cost: allTime.byAgent.claude.cost * 0.8 },
      { name: 'claude-sonnet-4-6', tokens: 7_800_000, cost: allTime.byAgent.claude.cost * 0.2 },
    ],
  };

  return {
    updatedAt: Date.now(),
    agents: AGENTS,
    today: tRow,
    yesterday: daily[daily.length - 2],
    month: thisMonth,
    daily,
    monthly,
    allTime: enrichMockAllTime(allTime),
    codexQuota: {
      ok: true,
      planType: 'pro',
      allowed: true,
      limitReached: false,
      primary: { usedPercent: 42, remainingPercent: 58, resetAfterSeconds: 9120 },
      secondary: { usedPercent: 17, remainingPercent: 83, resetAfterSeconds: 259200 },
    },
    error: null,
  };
}

function enrichMockAllTime(allTime) {
  // add token composition so the split bars render in preview
  for (const a of AGENTS) {
    const s = allTime.byAgent[a];
    s.inputTokens = Math.round(s.tokens * 0.55);
    s.outputTokens = Math.round(s.tokens * 0.12);
    s.cacheReadTokens = Math.round(s.tokens * 0.3);
    s.cacheCreationTokens = s.tokens - s.inputTokens - s.outputTokens - s.cacheReadTokens;
  }
  return allTime;
}
