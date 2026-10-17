# Agent Usage — menubar tray for Linux (GNOME Wayland/X11)

A lightweight GNOME top-bar tray that shows LLM token usage and spend per agent harness — **Codex**, **OpenCode**, and **Claude Code** — in one place. Shells out to [`ccusage`](https://ccusage.com) every 60s, aggregates by day/month/all-time, and surfaces Codex plan quota (`wham/usage`).

Built for developers running multiple AI harnesses who want an at-a-glance cost/token meter.

<p align="center">
  <img src="screenshots/01-all.png" width="32%" alt="All agents — Daily overview" />
  <img src="screenshots/02-graph-bars.png" width="32%" alt="Daily chart and history bars (scrolled)" />
  <img src="screenshots/03-codex.png" width="32%" alt="Codex — plan quota and model breakdown" />
</p>

## Features

- Tray icon + live context menu (today / month / all-time, per-harness `◆ Codex` / `● OpenCode` / `✳ Claude Code`)
- Popup dashboard: Daily / Monthly / All-time tabs, 14-day stacked chart, per-harness cards with model breakdowns
- Codex quota window (remaining % + reset timer) via `~/.codex/auth.json`
- Auto-refresh 60s, `R` to refresh, `Esc` to hide

Daily and monthly reports share one ccusage load. If a refresh loses a previously known model price, the app retains the last usage snapshot and shows an error until pricing recovers. Models with no available price are labeled **pricing unavailable**, and their totals are marked as partial. Offline pricing comes from ccusage's embedded catalog; `pricing-cache.json` stores status metadata, not model prices.

Run pricing and tray recovery regression checks with `npm test`.

## Requirements

- **Linux + GNOME** with AppIndicator (`sudo apt install gnome-shell-extension-appindicator` if tray missing)
- **busctl** (provided by systemd) for checking the desktop's tray registrations
- **Node.js ≥ 18** (`curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install nodejs`)
- **bun** or **npm** (bun preferred)
- **Python 3 + Pillow** for icons (`sudo apt install python3 python3-pip && pip install Pillow` — installer handles it)

> **ccusage is bundled** as a regular npm dependency and runs on Electron's own Node runtime (`ELECTRON_RUN_AS_NODE`) — no global install, PATH entry, or system Node needed. Set `CCUSAGE_BIN` to override with an external binary.

> Electron is pinned to **42.9.3** so reinstalling cannot silently change the runtime. Update it deliberately and repeat the tray recovery checks.

## Install

```bash
git clone https://github.com/aniketsaurav18/agent-menubar.git
cd agent-menubar
./install.sh
```

User-local by default (no sudo). The installer checks deps, runs `bun install`/`npm install`, regenerates the flat violet robot icon (`assets/icon.png` via `scripts/gen-icons.py`), ensures `ccusage`, and creates:

- `~/.local/share/applications/agent-menubar.desktop`
- `~/.config/autostart/agent-menubar.desktop`
- `~/.local/bin/agent-menubar` shim

```bash
./install.sh --help        # all options
./install.sh --systemd     # supervised service instead of desktop autostart
./install.sh --no-autostart
sudo ./install.sh --system # system-wide (/opt/agent-menubar)
./install.sh --uninstall   # remove entries / service / shim
```

On GNOME Wayland, all launch paths force `--ozone-platform=x11` for tray registration and popup positioning. The older `--ozone-platform-hint=x11` switch is ignored by current Electron.

The app waits for GNOME's tray host, then checks its own registration by process ID every 15 seconds. Two consecutive checks finding a lost registration, destroyed D-Bus interface, passive icon, or missing Chromium icon image trigger an app restart with a fresh D-Bus connection. Host changes can trigger recovery immediately. Replacing a Linux tray in-process can leave stale interfaces, so recovery uses a new process. Other probe errors preserve the existing icon. The checks log `[tray]` state changes; they verify registration and image availability, not whether GNOME has actually painted the icon.

For crash recovery, use `./install.sh --systemd`. The installer removes the duplicate desktop autostart entry, uses the graphical session's display environment, and preserves service mode on later reinstalls. Logs: `journalctl --user -u agent-menubar.service`. Choosing Quit exits normally; crashes restart automatically.

Launch: `agent-menubar`, `npm start`, or search **Agent Usage** in GNOME overview. Logs at `/tmp/opencode/agent-menubar.log` (or `journalctl --user -u agent-menubar.service -f` with `--systemd`).

## Uninstall

```bash
./install.sh --uninstall
sudo ./install.sh --system --uninstall  # if installed with --system
```

## Layout

```
src/main.js            tray, window, ccusage polling, IPC
src/tray-health.js     desktop tray registration checks and recovery
src/preload.js         contextBridge
src/renderer/          dashboard UI (no build step)
scripts/gen-icons.py   regenerates assets/icon.png
install.sh             installer
```

MIT
