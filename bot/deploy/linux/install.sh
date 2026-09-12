#!/usr/bin/env bash
#
# Takes a bare Debian or Ubuntu server to a running bot.
#
#   sudo bash deploy/linux/install.sh
#
# Run it from a checkout of this repository, on the server. It is idempotent:
# running it again upgrades an existing install in place, and never overwrites
# the .env or the state file.
#
# Why a server at all: on a laptop the bot stops whenever the lid closes, the
# machine sleeps or the user logs out, and a bar that closes in that window is
# a trade that never happened. A server has no lid.

set -euo pipefail

APP_DIR=/opt/bybit-bot
SERVICE=bybit-bot
RUN_USER=bot
NODE_MAJOR=22

log() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo — this installs a system service."

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
[[ -f "$SRC/package.json" ]] || die "Run this from the bot directory of a checkout; $SRC has no package.json."

# ---------------------------------------------------------------- node

if command -v node >/dev/null && [[ $(node -p 'process.versions.node.split(".")[0]') -ge $NODE_MAJOR ]]; then
  log "Node $(node -v) is new enough"
else
  log "Installing Node $NODE_MAJOR"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg git
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
    gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
  log "Installed Node $(node -v)"
fi

# The request signature carries a timestamp, and Bybit rejects one that drifts
# past the recv window. The bot re-syncs against server time when that happens,
# but a clock that is simply correct never gets there.
if ! timedatectl show --property=NTPSynchronized --value 2>/dev/null | grep -q yes; then
  log "Enabling clock sync"
  apt-get install -y -qq systemd-timesyncd || true
  timedatectl set-ntp true || true
fi

# ---------------------------------------------------------------- user and files

id -u "$RUN_USER" >/dev/null 2>&1 || {
  log "Creating the $RUN_USER service account"
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$RUN_USER"
}

log "Copying the bot to $APP_DIR"
install -d -o "$RUN_USER" -g "$RUN_USER" -m 0755 "$APP_DIR"
# --exclude keeps the deployed copy free of the developer's local state: never
# copy over a running bot's data directory or its .env.
tar -C "$SRC" --exclude=node_modules --exclude=data --exclude=.env --exclude=dist -cf - . |
  tar -C "$APP_DIR" -xf -
install -d -o "$RUN_USER" -g "$RUN_USER" -m 0750 "$APP_DIR/data"

log "Building"
( cd "$APP_DIR" && npm install --no-audit --no-fund --silent && npm run build --silent )
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"

# ---------------------------------------------------------------- credentials

if [[ ! -f "$APP_DIR/.env" ]]; then
  cat <<'EOF'

No .env on this server yet, so the bot has no API key and will not be started.

Create it now, as root, and paste the secret straight into the file — never
into a shell command, where it would land in the history and the process list:

  install -m 0600 -o bot -g bot /dev/null /opt/bybit-bot/.env
  nano /opt/bybit-bot/.env

Copy the settings from the machine you are moving off, or run the setup wizard:

  cd /opt/bybit-bot && sudo -u bot node dist/setup.js

Then run this script again. The API key must have Withdrawal disabled.
EOF
  exit 1
fi

chown "$RUN_USER:$RUN_USER" "$APP_DIR/.env"
chmod 0600 "$APP_DIR/.env"

# ---------------------------------------------------------------- verify, then start

log "Pre-flight check"
# Refuse to install a service that cannot trade. Better to fail here, visibly,
# than to leave a green systemd unit quietly rejecting every order.
( cd "$APP_DIR" && sudo -u "$RUN_USER" node dist/doctor.js ) ||
  die "Pre-flight failed. Fix what it reported, then run this script again; nothing was started."

log "Installing the $SERVICE service"
cp "$APP_DIR/deploy/bybit-bot.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

sleep 5
systemctl is-active --quiet "$SERVICE" ||
  die "The service did not stay up. See: journalctl -u $SERVICE -n 50"

cat <<EOF

==> Running. It starts on boot and restarts on crash, with no one logged in.

  Status   systemctl status $SERVICE
  Logs     journalctl -u $SERVICE -f
  Health   curl -s localhost:8090/health
  Stop     systemctl stop $SERVICE     (and: systemctl disable $SERVICE)

Before you leave it alone: stop the bot on the old machine. Two instances on
one account both see every signal, so each position is opened twice and every
risk limit — the daily loss stop included — holds at half the size you set.

EOF
