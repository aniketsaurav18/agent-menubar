const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Exercise the real main-process refresh without starting Electron or touching
// the user's snapshot/auth files. Only process, quota, and disk boundaries are stubbed.
function harness(reports = []) {
  const calls = [];
  const saved = [];
  let pricingTouches = 0;
  const app = { commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => false, quit() {} };
  const context = vm.createContext({
    require: (name) => name === 'electron' ? { app } : require(name),
    __dirname: path.resolve(__dirname, '../src'),
    process,
    console: { log() {}, warn() {}, error() {} },
    fakeRun: async (args, options = {}) => {
      calls.push({ args, options });
      const result = reports.shift();
      if (result instanceof Error) throw result;
      return result;
    },
    fakeSave: (snap) => saved.push(snap),
    fakeTouch: () => pricingTouches++,
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/main.js'), 'utf8') + `
    runCcusage = fakeRun;
    refreshQuota = async () => {};
    loadPricingCache = () => null;
    touchPricingCache = fakeTouch;
    saveSnapshotCache = fakeSave;
    globalThis.subject = {
      refresh,
      buildSnapshot,
      parseRows,
      setSnapshot: (value) => { snapshot = value; },
    };
  `, context);
  return { ...context.subject, calls, saved, touches: () => pricingTouches };
}

function report(cost, missingPricing = false) {
  const entry = {
    agent: 'codex', totalCost: cost, totalTokens: 100,
    modelBreakdowns: [{ modelName: 'new-model', cost, inputTokens: 10, outputTokens: 20, cacheReadTokens: 70, missingPricing }],
  };
  return {
    daily: [{ period: '2026-10-11', agents: [entry] }],
    monthly: [{ period: '2026-10', agents: [entry] }],
  };
}

test('daily and monthly share a single pricing load', async () => {
  const h = harness([report(7.43)]);
  const snap = await h.refresh();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(Array.from(h.calls[0].args), ['--sections', 'daily,monthly', '--json', '--by-agent', '--breakdown']);
  assert.equal(snap.allTime.cost, 7.43);
  assert.equal(snap.daily[0].byAgent.codex.models[0].tokens, 100);
  assert.equal(h.touches(), 1);
});

test('an online success with missing pricing preserves previously priced usage', async () => {
  const h = harness([report(7.43), report(0, true)]);
  const good = await h.refresh();
  const rejected = await h.refresh();
  assert.equal(rejected.allTime.cost, 7.43);
  assert.equal(rejected.updatedAt, good.updatedAt);
  assert.match(rejected.error, /Pricing unavailable for codex\/new-model/);
  assert.equal(h.saved.length, 1);
  assert.equal(h.touches(), 1);
});

test('offline fallback cannot overwrite previously priced usage', async () => {
  const h = harness([report(7.43), new Error('network down'), report(0, true)]);
  await h.refresh();
  const rejected = await h.refresh();
  assert.equal(h.calls[2].options.offline, true);
  assert.equal(rejected.allTime.cost, 7.43);
  assert.match(rejected.error, /keeping last usage/);
  assert.equal(h.saved.length, 1);
});

test('new unpriced models keep their missing flag and report partial costs', async () => {
  const h = harness([report(0, true)]);
  const snap = await h.refresh();
  assert.equal(snap.daily[0].byAgent.codex.models[0].missingPricing, true);
  assert.equal(snap.allTime.modelsByAgent.codex[0].missingPricing, true);
  assert.equal(snap.pricingStatus.unpricedModels[0].name, 'new-model');
  assert.equal(h.touches(), 0);
});

test('known free models remain valid zero-cost results', async () => {
  const h = harness([report(7.43), report(0)]);
  await h.refresh();
  const snap = await h.refresh();
  assert.equal(snap.error, null);
  assert.equal(snap.allTime.cost, 0);
  assert.equal(snap.pricingStatus.unpricedModels.length, 0);
});

test('partly unpriced history cannot replace complete history', async () => {
  const partial = report(1);
  partial.monthly.unshift({ period: '2026-09', agents: report(0, true).monthly[0].agents });
  const h = harness([report(7.43), partial]);
  await h.refresh();
  const rejected = await h.refresh();
  assert.equal(rejected.allTime.cost, 7.43);
  assert.match(rejected.error, /Pricing unavailable/);
});

test('successful pricing recovery clears the error immediately', async () => {
  const h = harness([report(7.43), report(0, true), report(8)]);
  await h.refresh();
  await h.refresh();
  const recovered = await h.refresh();
  assert.equal(recovered.error, null);
  assert.equal(recovered.allTime.cost, 8);
  assert.equal(h.saved.length, 2);
});

test('already partial history can still update token usage', async () => {
  const first = report(1, true);
  const next = report(2, true);
  const h = harness([first, next]);
  await h.refresh();
  const updated = await h.refresh();
  assert.equal(updated.error, null);
  assert.equal(updated.allTime.cost, 2);
  assert.equal(updated.pricingStatus.unpricedModels.length, 1);
  assert.equal(h.saved.length, 2);
});

test('usable offline report is labeled and does not refresh pricing timestamp', async () => {
  const h = harness([new Error('network down'), report(1)]);
  const snap = await h.refresh();
  assert.equal(snap.pricingStatus.offline, true);
  assert.equal(snap.allTime.cost, 1);
  assert.equal(h.touches(), 0);
});

test('invalid report sections preserve the last snapshot', async () => {
  const h = harness([report(7.43), { daily: [] }]);
  await h.refresh();
  const rejected = await h.refresh();
  assert.equal(rejected.allTime.cost, 7.43);
  assert.match(rejected.error, /report sections/);
  assert.equal(h.saved.length, 1);
});
