const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');

const execFileP = promisify(execFile);
const WATCHER = 'org.kde.StatusNotifierWatcher';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS = 'org.freedesktop.DBus';

async function busCall(destination, objectPath, iface, method, ...args) {
  const { stdout } = await execFileP('busctl', [
    '--user', '--json=short', '--timeout=2', 'call',
    destination, objectPath, iface, method, ...args,
  ], { timeout: 3000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  return JSON.parse(stdout).data[0];
}

function noOwner(err) {
  return /NameHasNoOwner|ServiceUnknown|does not exist|no such name|not provided by any/.test(err.stderr || '');
}

// A running Electron process (or even a non-destroyed Tray) does not prove
// that GNOME has its icon. Check the host's actual registrations by PID.
async function probeTray(pid, call = busCall) {
  let owner;
  try {
    owner = await call(DBUS, DBUS_PATH, DBUS, 'GetNameOwner', 's', WATCHER);
  } catch (err) {
    if (noOwner(err)) return { owner: null, registered: false };
    throw err;
  }
  const items = await call(owner, '/StatusNotifierWatcher',
    'org.freedesktop.DBus.Properties', 'Get', 'ss', WATCHER, 'RegisteredStatusNotifierItems');
  if (items.type !== 'as' || !Array.isArray(items.data)) {
    throw new Error('Unexpected RegisteredStatusNotifierItems response');
  }
  for (const item of items.data) {
    const separator = item.indexOf('@/');
    if (separator < 0) continue;
    const service = item.slice(0, separator);
    const objectPath = item.slice(separator + 1);
    let itemPid;
    try {
      itemPid = await call(DBUS, DBUS_PATH, DBUS, 'GetConnectionUnixProcessID', 's', service);
    } catch (err) {
      if (noOwner(err)) continue; // An unrelated app exited during this probe.
      throw err;
    }
    if (itemPid !== pid) continue;
    let props;
    try {
      props = await call(service, objectPath,
        'org.freedesktop.DBus.Properties', 'GetAll', 's', 'org.kde.StatusNotifierItem');
    } catch (err) {
      if (/Method is no longer available|UnknownMethod|UnknownObject/.test(err.stderr || '')) {
        return { owner, registered: false, reason: 'tray D-Bus object disappeared' };
      }
      throw err;
    }
    // Chromium exports its image through a temporary theme directory. If a
    // cleanup removes it, registration survives but GNOME cannot draw the icon.
    const icon = props.IconName?.data;
    const theme = props.IconThemePath?.data;
    if (icon?.startsWith('status_icon_') && theme && path.isAbsolute(theme) &&
        !fs.existsSync(path.join(theme, `${icon}.png`))) {
      return { owner, registered: false, reason: 'tray image file disappeared' };
    }
    if (props.Status?.data === 'Passive') {
      return { owner, registered: false, reason: 'tray became passive' };
    }
    return { owner, registered: true };
  }
  return { owner, registered: false, reason: 'tray registration missing' };
}

function createTrayMonitor({
  recreate, pid = process.pid, probe = probeTray, logger = console,
  intervalMs = 15_000,
}) {
  let timer;
  let stopped = false;
  let checking = false;
  let lastOwner = null;
  let misses = 0;
  let lastState;
  function report(state) {
    if (state === lastState) return;
    lastState = state;
    logger.log(`[tray] ${state}`);
  }
  async function check() {
    if (stopped || checking) return;
    checking = true;
    try {
      const health = await probe(pid);
      if (stopped) return;
      if (!health.owner) {
        lastOwner = null;
        misses = 0;
        report('waiting for desktop tray host');
        return;
      }
      const hostChanged = health.owner !== lastOwner;
      lastOwner = health.owner;
      if (health.registered) {
        misses = 0;
        report('registered with desktop tray host');
      } else if (hostChanged || ++misses >= 2) {
        report(`recovering tray: ${health.reason || 'host changed'}`);
        await recreate();
        misses = 0;
      }
    } catch (err) {
      // A failed probe is not proof of a lost icon. Keep the existing tray.
      report(`health check failed: ${err.message}`);
    } finally {
      checking = false;
    }
  }
  return {
    check,
    start() {
      if (timer || stopped) return;
      void check();
      timer = setInterval(check, intervalMs);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

module.exports = { probeTray, createTrayMonitor };
