#!/bin/sh
# Installs the bot as a launchd agent on macOS: starts at login, restarts on exit.
#
# Needs no sudo — a LaunchAgent is per-user. Run it from anywhere:
#   sh bot/deploy/macos/install.sh
#
# Replaces a nohup-started bot: it stops the unsupervised one first, so the
# single-instance lock is never contested.
set -eu

LABEL=com.trading-mcp.bot
BOTDIR=$(cd "$(dirname "$0")/../.." && pwd)
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPLATE="$BOTDIR/deploy/macos/$LABEL.plist.template"

[ -f "$BOTDIR/dist/index.js" ] || { echo "No build at $BOTDIR/dist/index.js — run 'npm run build' first." >&2; exit 1; }
[ -f "$BOTDIR/.env" ] || { echo "No $BOTDIR/.env — create it before installing." >&2; exit 1; }

NODE=$(command -v node || true)
[ -n "$NODE" ] || { echo "node not found on PATH." >&2; exit 1; }
CAFFEINATE=$(command -v caffeinate || echo /usr/bin/caffeinate)

echo "bot dir : $BOTDIR"
echo "node    : $NODE"

# An unsupervised instance would hold the lock and make launchd's copy exit 1
# every 30 seconds forever.
if pgrep -f "dist/index.js" >/dev/null 2>&1; then
  echo "stopping the unsupervised bot already running..."
  pkill -TERM -f "dist/index.js" || true
  i=0
  while pgrep -f "dist/index.js" >/dev/null 2>&1 && [ "$i" -lt 30 ]; do sleep 1; i=$((i+1)); done
fi

mkdir -p "$HOME/Library/LaunchAgents" "$BOTDIR/data"
sed -e "s|__BOTDIR__|$BOTDIR|g" -e "s|__NODE__|$NODE|g" -e "s|__CAFFEINATE__|$CAFFEINATE|g" \
  "$TEMPLATE" > "$PLIST"
chmod 644 "$PLIST"

# bootout is the modern unload; ignore failure when it was never loaded.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"

echo
echo "Installed $PLIST"
echo "The bot now starts at login and restarts if it ever exits."
echo
echo "  status : launchctl print gui/$(id -u)/$LABEL | head -20"
echo "  stop   : launchctl bootout gui/$(id -u)/$LABEL"
echo "  start  : launchctl bootstrap gui/$(id -u) $PLIST"
echo "  health : curl -s http://127.0.0.1:8090/health"
