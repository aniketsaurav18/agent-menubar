#!/usr/bin/env bash
set -euo pipefail

# Agent Usage — installer for Linux (GNOME Wayland/X11)
# Usage: ./install.sh [--system] [--no-autostart] [--systemd] [--uninstall] [--help]
# Default: user-local install (~/.local/share/applications, ~/.config/autostart)

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Agent Usage"
APP_ID="agent-menubar"
BIN_NAME="agent-menubar"

SYSTEM=false
NO_AUTOSTART=false
WITH_SYSTEMD=false
UNINSTALL=false

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}▸${NC} $*"; }
ok()    { echo -e "${GREEN}✔${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
fail()  { echo -e "${RED}✘${NC} $*" >&2; }

usage() {
  cat <<EOF
Agent Usage installer

Usage: ./install.sh [options]

Options:
  --system        System-wide install (/opt/$APP_ID, /usr/share/applications)
                  Requires sudo. Default is user-local (~/.local).
  --no-autostart  Skip autostart entry
  --systemd       Also install & enable systemd --user service (autostart via systemd)
  --uninstall     Remove desktop entries / autostart / systemd service
  --help          Show this help

What it does (user-local):
  1. Checks node, python3, package manager
  2. Installs npm deps (electron v42) + regenerates assets/icon.png
  3. Ensures ccusage is available (prompts to install if missing)
  4. Creates ~/.local/share/applications/$APP_ID.desktop
  5. Creates ~/.config/autostart/$APP_ID.desktop (unless --no-autostart)
  6. Optionally creates ~/.config/systemd/user/$APP_ID.service

Run after install:
  npm start  — or —  $BIN_NAME (if added to PATH)  — or launch "Agent Usage" from GNOME overview
EOF
}

for arg in "$@"; do
  case "$arg" in
    --system) SYSTEM=true ;;
    --no-autostart) NO_AUTOSTART=true ;;
    --systemd) WITH_SYSTEMD=true ;;
    --uninstall) UNINSTALL=true ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $arg"; usage; exit 1 ;;
  esac
done

if [[ "$SYSTEM" == true && "$EUID" -ne 0 ]]; then
  fail "--system requires sudo. Re-run with: sudo ./install.sh --system"
  exit 1
fi

# ── paths ──────────────────────────────────────────────────────────────────
if [[ "$SYSTEM" == true ]]; then
  INSTALL_DIR="/opt/$APP_ID"
  DESKTOP_DIR="/usr/share/applications"
  AUTOSTART_DIR="/etc/xdg/autostart"
  SYSTEMD_DIR="/etc/systemd/user"
  ICON_SRC="$INSTALL_DIR/assets/icon.png"
  ELECTRON_BIN="$INSTALL_DIR/node_modules/.bin/electron"
else
  DESKTOP_DIR="$HOME/.local/share/applications"
  AUTOSTART_DIR="$HOME/.config/autostart"
  SYSTEMD_DIR="$HOME/.config/systemd/user"
  ICON_SRC="$REPO_DIR/assets/icon.png"
  ELECTRON_BIN="$REPO_DIR/node_modules/.bin/electron"
fi

DESKTOP_FILE="$DESKTOP_DIR/$APP_ID.desktop"
AUTOSTART_FILE="$AUTOSTART_DIR/$APP_ID.desktop"
SERVICE_FILE="$SYSTEMD_DIR/$APP_ID.service"

uninstall() {
  info "Uninstalling $APP_NAME..."
  # stop running instance (match both electron binary and node wrapper)
  pkill -f "electron.*$REPO_DIR" 2>/dev/null || true
  pkill -f "node.*electron.*$REPO_DIR" 2>/dev/null || true
  if [[ "$SYSTEM" == true && -d "/opt/$APP_ID" ]]; then
    pkill -f "electron.*/opt/$APP_ID" 2>/dev/null || true
    pkill -f "node.*electron.*/opt/$APP_ID" 2>/dev/null || true
  fi
  # give it a moment to exit, then SIGKILL if still around
  sleep 1
  pkill -9 -f "electron.*$REPO_DIR" 2>/dev/null || true
  pkill -9 -f "node.*electron.*$REPO_DIR" 2>/dev/null || true
  if systemctl --user is-active --quiet "$APP_ID.service" 2>/dev/null; then
    systemctl --user disable --now "$APP_ID.service" 2>/dev/null || true
  fi
  rm -f "$DESKTOP_FILE" "$AUTOSTART_FILE" "$SERVICE_FILE"
  # shim
  rm -f "$HOME/.local/bin/$BIN_NAME" 2>/dev/null || true
  if [[ "$SYSTEM" == true ]]; then
    rm -f "/usr/local/bin/$BIN_NAME" 2>/dev/null || true
  fi
  if [[ "$SYSTEM" == true ]]; then
    rm -rf "/opt/$APP_ID"
  fi
  # reload
  update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
  if [[ "$SYSTEM" == false ]]; then
    systemctl --user daemon-reload 2>/dev/null || true
  else
    systemctl daemon-reload 2>/dev/null || true
  fi
  ok "Uninstalled. (node_modules and assets left intact; delete repo manually if needed)"
  exit 0
}

if [[ "$UNINSTALL" == true ]]; then
  uninstall
fi

echo ""
echo -e "${CYAN}━━━ $APP_NAME installer ━━━${NC}"
echo "Repo: $REPO_DIR"
if [[ "$SYSTEM" == true ]]; then echo "Mode: system-wide (/opt/$APP_ID)"; else echo "Mode: user-local"; fi
echo ""

# ── 1. OS & deps ───────────────────────────────────────────────────────────
if [[ "$(uname -s)" != "Linux" ]]; then
  warn "This tray app is Linux-only (GNOME Wayland/X11). Continuing anyway..."
fi

need_cmd() {
  if ! command -v "$1" &>/dev/null; then
    fail "Missing required command: $1 — $2"
    exit 1
  fi
}

need_cmd python3 "install python3 (sudo apt install python3 python3-pip / sudo dnf install python3)"

# node
if ! command -v node &>/dev/null; then
  fail "node not found. Install Node.js 18+ (https://nodejs.org) or via your package manager."
  echo "  Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install nodejs"
  echo "  Fedora: sudo dnf install nodejs"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  warn "node v$NODE_MAJOR detected — v18+ recommended for Electron 42."
fi
ok "node $(node --version) found"

# package manager — prefer bun, fall back to npm
PM=""
PM_INSTALL=""
if command -v bun &>/dev/null; then
  PM="bun"; PM_INSTALL="bun install"
elif command -v npm &>/dev/null; then
  PM="npm"; PM_INSTALL="npm install"
else
  fail "Neither bun nor npm found. Install Node.js with npm, or install bun (curl -fsSL https://bun.sh/install | bash)"
  exit 1
fi
info "Using $PM ($PM_INSTALL)"

# ── 2. system-wide copy ───────────────────────────────────────────────────
if [[ "$SYSTEM" == true ]]; then
  info "Copying repo to $INSTALL_DIR ..."
  mkdir -p "$INSTALL_DIR"
  # rsync-like copy excluding node_modules/.git to keep it clean
  if command -v rsync &>/dev/null; then
    rsync -a --delete --exclude='node_modules' --exclude='.git' --exclude='/tmp' "$REPO_DIR"/ "$INSTALL_DIR"/
  else
    cp -a "$REPO_DIR"/. "$INSTALL_DIR"/
    rm -rf "$INSTALL_DIR/node_modules" 2>/dev/null || true
  fi
  # from here on operate on INSTALL_DIR
  REPO_DIR="$INSTALL_DIR"
  ICON_SRC="$REPO_DIR/assets/icon.png"
  ELECTRON_BIN="$REPO_DIR/node_modules/.bin/electron"
  ok "Copied to $INSTALL_DIR"
fi

# ── 3. install deps ───────────────────────────────────────────────────────
info "Installing dependencies ($PM_INSTALL) ..."
(
  cd "$REPO_DIR"
  # shellcheck disable=SC2086
  $PM_INSTALL
)
ok "Dependencies installed"

# ensure electron binary fetched (seen on some distros)
if [[ ! -x "$ELECTRON_BIN" ]]; then
  warn "electron binary not found at $ELECTRON_BIN — fetching..."
  (cd "$REPO_DIR" && node node_modules/electron/install.js 2>/dev/null || ./node_modules/.bin/install-electron 2>/dev/null || true)
fi
if [[ -x "$ELECTRON_BIN" ]]; then
  ok "electron $("$ELECTRON_BIN" --version 2>/dev/null || echo "found")"
else
  warn "electron binary still missing — try: ./node_modules/.bin/install-electron"
fi

# ── 4. Pillow + icons ─────────────────────────────────────────────────────
if ! python3 -c "import PIL" 2>/dev/null; then
  info "Installing Pillow (for icon generation) ..."
  if python3 -m pip install --user Pillow 2>/dev/null; then
    ok "Pillow installed"
  elif pip3 install --user Pillow 2>/dev/null; then
    ok "Pillow installed"
  else
    warn "Could not install Pillow — icons will be skipped. Install manually: pip install Pillow"
  fi
else
  ok "Pillow found"
fi

if python3 -c "import PIL" 2>/dev/null; then
  info "Generating icons ..."
  (cd "$REPO_DIR" && python3 scripts/gen-icons.py)
  ok "Icons generated ($(stat -c%s "$REPO_DIR/assets/icon.png" 2>/dev/null || stat -f%z "$REPO_DIR/assets/icon.png" 2>/dev/null || echo "?") B)"
else
  warn "Skipping icon generation (Pillow missing)"
fi

# ── 5. ccusage ────────────────────────────────────────────────────────────
if command -v ccusage &>/dev/null; then
  ok "ccusage found ($(command -v ccusage))"
elif [[ -n "${CCUSAGE_BIN:-}" && -x "$CCUSAGE_BIN" ]]; then
  ok "ccusage found via CCUSAGE_BIN=$CCUSAGE_BIN"
else
  warn "ccusage not found on PATH."
  echo "      The tray shells out to ccusage for usage data."
  echo "      Install with one of:"
  echo "        bun add -g ccusage   (or npm i -g ccusage)"
  echo "        bunx ccusage --help  (try without global install)"
  echo "      Or set CCUSAGE_BIN=/path/to/ccusage before launching."
  # non-fatal: don't exit, just warn
  if [[ -t 0 ]]; then
    read -rp "Install ccusage globally now via $PM? [y/N] " ans
    if [[ "$ans" =~ ^[Yy] ]]; then
      if [[ "$PM" == "bun" ]]; then bun add -g ccusage || npm i -g ccusage || true
      else npm i -g ccusage || bun add -g ccusage || true
      fi
      command -v ccusage &>/dev/null && ok "ccusage installed" || warn "ccusage install may need PATH update"
    fi
  fi
fi

# ── 6. desktop entry ──────────────────────────────────────────────────────
mkdir -p "$DESKTOP_DIR"
# Electron needs --no-sandbox unless chrome-sandbox is setuid-root (see README)
# Use XWayland backend for tray (native Wayland can't position popup nor register SNI reliably)
EXEC_LINE="\"$ELECTRON_BIN\" \"$REPO_DIR\" --no-sandbox"
# wrapper to ensure correct env when launched from GNOME
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=$APP_NAME
Comment=Menubar tray showing LLM token usage per agent harness (codex, opencode, claude)
Exec=$EXEC_LINE
Icon=$ICON_SRC
Terminal=false
Categories=Utility;Development;
StartupWMClass=agent-menubar
Keywords=agent;llm;token;usage;codex;opencode;claude;
X-GNOME-Autostart-enabled=true
EOF
chmod 644 "$DESKTOP_FILE"
ok "Desktop entry → $DESKTOP_FILE"

# update desktop DB
update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true

# ── 7. autostart ──────────────────────────────────────────────────────────
if [[ "$NO_AUTOSTART" == false ]]; then
  mkdir -p "$AUTOSTART_DIR"
  cp -f "$DESKTOP_FILE" "$AUTOSTART_FILE"
  ok "Autostart → $AUTOSTART_FILE"
else
  info "Skipping autostart (--no-autostart)"
fi

# ── 8. systemd user service (optional) ────────────────────────────────────
if [[ "$WITH_SYSTEMD" == true ]]; then
  mkdir -p "$SYSTEMD_DIR"
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Agent Usage — menubar tray (Electron)
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=$ELECTRON_BIN $REPO_DIR --no-sandbox
Restart=on-failure
RestartSec=3
Environment=DISPLAY=:0
# Keep Wayland/X11 vars from user session (systemd --user imports them)
# If tray doesn't appear, ensure graphical-session.target is active:
#   systemctl --user status graphical-session.target

[Install]
WantedBy=graphical-session.target
EOF
  chmod 644 "$SERVICE_FILE"
  if [[ "$SYSTEM" == false ]]; then
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user enable "$APP_ID.service" 2>/dev/null || warn "Could not enable systemd service (no user systemd?)"
    ok "systemd service → $SERVICE_FILE (enabled)"
    info "Start it now: systemctl --user start $APP_ID.service"
    info "Logs: journalctl --user -u $APP_ID.service -f"
  else
    systemctl daemon-reload 2>/dev/null || true
    ok "systemd service → $SERVICE_FILE (run: systemctl --user enable $APP_ID.service)"
  fi
fi

# ── 9. optional shim in ~/.local/bin ─────────────────────────────────────
if [[ "$SYSTEM" == false ]]; then
  SHIM_DIR="$HOME/.local/bin"
  SHIM_FILE="$SHIM_DIR/$BIN_NAME"
  mkdir -p "$SHIM_DIR"
  cat > "$SHIM_FILE" <<EOF
#!/usr/bin/env bash
exec "$ELECTRON_BIN" "$REPO_DIR" --no-sandbox "\$@"
EOF
  chmod +x "$SHIM_FILE"
  ok "CLI shim → $SHIM_FILE"
  if [[ ":$PATH:" != *":$SHIM_DIR:"* ]]; then
    warn "~/.local/bin not in PATH — add to ~/.bashrc/.zshrc: export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
fi

# ── 10. chrome-sandbox hint ───────────────────────────────────────────────
SANDBOX="$REPO_DIR/node_modules/electron/dist/chrome-sandbox"
if [[ -f "$SANDBOX" && ! -u "$SANDBOX" ]]; then
  warn "chrome-sandbox is not setuid. You can either keep --no-sandbox (default) or run:"
  echo "      sudo chown root \"$SANDBOX\" && sudo chmod 4755 \"$SANDBOX\""
  echo "      then remove --no-sandbox from Exec line in $DESKTOP_FILE"
fi

# ── done ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━ Installed ━━━${NC}"
echo "Launch now:  ${CYAN}npm start${NC}  (in $REPO_DIR)"
if [[ "$SYSTEM" == false ]]; then
  echo "             ${CYAN}$BIN_NAME${NC}  (if ~/.local/bin in PATH)"
fi
echo "             or search \"Agent Usage\" in GNOME overview"
echo ""
echo "Autostart:   $([[ "$NO_AUTOSTART" == true ]] && echo "disabled" || echo "enabled ($AUTOSTART_FILE)")"
if [[ "$WITH_SYSTEMD" == true ]]; then
  echo "systemd:     enabled — systemctl --user start $APP_ID.service"
fi
if [[ "$SYSTEM" == true ]]; then
  echo "Uninstall:   ${CYAN}sudo ./install.sh --system --uninstall${NC}"
else
  echo "Uninstall:   ${CYAN}./install.sh --uninstall${NC}"
fi
echo "Logs:        ${CYAN}/tmp/opencode/agent-menubar.log${NC}  (or journalctl --user -u $APP_ID.service)"
echo ""
read -rp "Start $APP_NAME now? [Y/n] " ans
if [[ ! "$ans" =~ ^[Nn] ]]; then
  info "Starting $APP_NAME ..."
  # kill old instance if any
  pkill -f "electron.*$REPO_DIR" 2>/dev/null || true
  sleep 1
  if [[ "$WITH_SYSTEMD" == true ]] && systemctl --user is-enabled --quiet "$APP_ID.service" 2>/dev/null; then
    systemctl --user restart "$APP_ID.service" 2>/dev/null || true
    ok "Started via systemd"
  else
    # launch detached with proper Wayland/X11 env
    # shellcheck disable=SC2016
    setsid env XDG_SESSION_TYPE="${XDG_SESSION_TYPE:-wayland}" \
      XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" \
      WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}" \
      DISPLAY="${DISPLAY:-:1}" \
      DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}" \
      nohup "$ELECTRON_BIN" "$REPO_DIR" --no-sandbox --remote-debugging-port=9222 \
      > /tmp/opencode/agent-menubar.log 2>&1 < /dev/null &
    sleep 2
    if pgrep -f "electron.*$REPO_DIR" &>/dev/null; then
      ok "Started (PID $(pgrep -f "electron.*$REPO_DIR" | head -1))"
    else
      warn "Launch may have failed — check /tmp/opencode/agent-menubar.log"
      tail -20 /tmp/opencode/agent-menubar.log 2>/dev/null || true
    fi
  fi
fi
