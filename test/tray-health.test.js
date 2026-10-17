const assert = require('node:assert/strict');
const test = require('node:test');
const { probeTray, createTrayMonitor } = require('../src/tray-health');

function monitorHarness() {
  let health = { owner: null, registered: false };
  let recreations = 0;
  const monitor = createTrayMonitor({
    probe: async () => {
      if (health instanceof Error) throw health;
      return health;
    },
    recreate: () => recreations++, logger: { log() {} },
  });
  return {
    ...monitor,
    set: value => { health = value; },
    count: () => recreations,
  };
}

test('waits for a late desktop host, then creates the tray', async () => {
  const h = monitorHarness();
  await h.check();
  await h.check();
  assert.equal(h.count(), 0);
  h.set({ owner: ':1.1', registered: false });
  await h.check();
  assert.equal(h.count(), 1);
  h.set({ owner: ':1.1', registered: true });
  await h.check();
  await h.check();
  assert.equal(h.count(), 1);
});

test('recovers after the tray extension disappears and returns in the same shell', async () => {
  const h = monitorHarness();
  h.set({ owner: ':1.1', registered: true });
  await h.check();
  h.set({ owner: null, registered: false });
  await h.check();
  h.set({ owner: ':1.1', registered: false });
  await h.check();
  assert.equal(h.count(), 1);
});

test('recreates after a host restart without waiting for a missing-host poll', async () => {
  const h = monitorHarness();
  h.set({ owner: ':1.1', registered: true });
  await h.check();
  h.set({ owner: ':1.2', registered: false });
  await h.check();
  assert.equal(h.count(), 1);
});

test('a lost registration needs two misses and healthy checks do not churn icons', async () => {
  const h = monitorHarness();
  h.set({ owner: ':1.1', registered: true });
  await h.check();
  h.set({ owner: ':1.1', registered: false });
  await h.check();
  assert.equal(h.count(), 0);
  await h.check();
  assert.equal(h.count(), 1);
  h.set({ owner: ':1.1', registered: true });
  await h.check();
  assert.equal(h.count(), 1);
});

test('probe errors do not destroy a working icon, and stop prevents late recreation', async () => {
  const h = monitorHarness();
  h.set(new Error('D-Bus timed out'));
  await h.check();
  assert.equal(h.count(), 0);
  h.stop();
  h.set({ owner: ':1.1', registered: false });
  await h.check();
  assert.equal(h.count(), 0);
});

test('concurrent probes are serialized and shutdown cancels an in-flight repair', async () => {
  let resolveProbe;
  let calls = 0;
  let recreations = 0;
  const monitor = createTrayMonitor({
    probe: () => { calls++; return new Promise(resolve => { resolveProbe = resolve; }); },
    recreate: () => recreations++, logger: { log() {} },
  });
  const pending = monitor.check();
  await monitor.check();
  assert.equal(calls, 1);
  monitor.stop();
  resolveProbe({ owner: ':1.1', registered: false });
  await pending;
  assert.equal(recreations, 0);
});

function fakeBus({ pid = 123, props = {}, items = [':1.5@/StatusNotifierItem'] } = {}) {
  return async (_dest, _path, _iface, method) => {
    if (method === 'GetNameOwner') return ':1.1';
    if (method === 'Get') return { type: 'as', data: items };
    if (method === 'GetConnectionUnixProcessID') return pid;
    if (method === 'GetAll') return props;
    throw new Error(`Unexpected call: ${method}`);
  };
}

test('registration belongs to our PID, not another Electron app', async () => {
  assert.equal((await probeTray(123, fakeBus())).registered, true);
  assert.equal((await probeTray(456, fakeBus())).registered, false);
});

test('detects missing Chromium icon images even when still registered', async () => {
  const props = {
    IconName: { type: 's', data: 'status_icon_0' },
    IconThemePath: { type: 's', data: '/nonexistent-agent-menubar-test' },
    Status: { type: 's', data: 'Active' },
  };
  const health = await probeTray(123, fakeBus({ props }));
  assert.equal(health.registered, false);
  assert.match(health.reason, /image file/);
});

test('detects passive icons and distinguishes missing hosts from probe failures', async () => {
  assert.equal((await probeTray(123, fakeBus({ props: {
    Status: { type: 's', data: 'Passive' },
  } }))).registered, false);
  for (const stderr of ['NameHasNoOwner', "Could not get owner of name: no such name"]) {
    const missing = Object.assign(new Error('missing'), { stderr });
    assert.deepEqual(await probeTray(123, async () => { throw missing; }),
      { owner: null, registered: false });
  }
  await assert.rejects(probeTray(123, async () => { throw new Error('timeout'); }), /timeout/);
});

test('detects a stale registration whose D-Bus interface was destroyed', async () => {
  const call = fakeBus();
  const health = await probeTray(123, async (...args) => {
    if (args[3] === 'GetAll') {
      throw Object.assign(new Error('stale item'), { stderr: 'Method is no longer available' });
    }
    return call(...args);
  });
  assert.equal(health.registered, false);
  assert.match(health.reason, /D-Bus object/);
});
