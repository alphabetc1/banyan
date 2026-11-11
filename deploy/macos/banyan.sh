#!/usr/bin/env bash
# Runs Banyan as launchd user services on a Mac: the room server, a daily database backup,
# and one runner per room. Data lives in ~/.banyan (override with BANYAN_HOME).
#
#   banyan.sh install-server          build the UI and start the server (http://127.0.0.1:7700)
#   banyan.sh uninstall-server        stop the server and backup jobs (data is kept)
#   banyan.sh register-runner ROOM    register this Mac as a runner; reads BANYAN_MEMBER_TOKEN
#   banyan.sh install-runner ROOM     run the registered runner for ROOM as a service
#   banyan.sh uninstall-runner ROOM   stop that runner service
#   banyan.sh backup-now              take a database backup immediately
#   banyan.sh status                  show services and server health
#   banyan.sh logs [server|ROOM]      follow logs
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOME_DIR="${BANYAN_HOME:-$HOME/.banyan}"
PORT="${BANYAN_PORT:-7700}"
SERVER_URL="http://127.0.0.1:${PORT}"
AGENTS_DIR="${BANYAN_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
# BANYAN_DRY_RUN=1 writes the plists without loading them (for checking what would be installed).
DRY_RUN="${BANYAN_DRY_RUN:-0}"
DOMAIN="gui/$(id -u)"
TSX="$REPO/node_modules/.bin/tsx"
LABEL_PREFIX="local.banyan"

# launchd starts services with a minimal PATH; carry over where node, git, claude and codex live.
service_path() {
  local dirs=()
  for tool in node git claude codex; do
    local found
    found="$(command -v "$tool" 2>/dev/null || true)"
    [[ -n "$found" ]] && dirs+=("$(dirname "$found")")
  done
  dirs+=(/usr/local/bin /opt/homebrew/bin /usr/bin /bin /usr/sbin /sbin)
  local IFS=:
  echo "${dirs[*]}" | tr ':' '\n' | awk '!seen[$0]++' | paste -sd: -
}

die() {
  echo "banyan: $*" >&2
  exit 1
}

# write_plist LABEL KEEPALIVE_XML SCHEDULE_XML LOG ENV_XML ARG...
write_plist() {
  local label="$1" keepalive="$2" schedule="$3" log="$4" env="$5"
  shift 5
  local args=""
  for a in "$@"; do args+="    <string>${a}</string>"$'\n'; done
  mkdir -p "$AGENTS_DIR" "$HOME_DIR/logs"
  cat >"$AGENTS_DIR/${label}.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}  </array>
  <key>WorkingDirectory</key>
  <string>${REPO}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(service_path)</string>
${env}  </dict>
${keepalive}${schedule}  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
EOF
}

env_entry() {
  printf '    <key>%s</key>\n    <string>%s</string>\n' "$1" "$2"
}

load() {
  [[ "$DRY_RUN" == 1 ]] && return 0
  launchctl bootout "$DOMAIN/$1" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$AGENTS_DIR/$1.plist"
}

unload() {
  [[ "$DRY_RUN" == 1 ]] && return 0
  launchctl bootout "$DOMAIN/$1" 2>/dev/null || true
  rm -f "$AGENTS_DIR/$1.plist"
}

wait_healthy() {
  [[ "$DRY_RUN" == 1 ]] && return 0
  for _ in $(seq 1 30); do
    curl -fsS "$SERVER_URL/api/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "server did not become healthy; see $HOME_DIR/logs/server.log"
}

server_env() {
  env_entry BANYAN_DB "$HOME_DIR/server/banyan.sqlite"
}

install_server() {
  [[ -x "$TSX" ]] || die "dependencies missing; run 'pnpm install' in $REPO first"
  if [[ "$DRY_RUN" != 1 ]] && lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && ! launchctl print "$DOMAIN/$LABEL_PREFIX.server" >/dev/null 2>&1; then
    die "port $PORT is already in use by another process; stop it or set BANYAN_PORT"
  fi
  mkdir -p "$HOME_DIR/server"
  (cd "$REPO" && pnpm --filter @banyan/web build >/dev/null)
  local always='  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
'
  write_plist "$LABEL_PREFIX.server" "$always" "" "$HOME_DIR/logs/server.log" \
    "$(server_env; env_entry BANYAN_HOST 127.0.0.1; env_entry BANYAN_PORT "$PORT"; env_entry BANYAN_WEB_DIR "$REPO/packages/web/dist")" \
    "$TSX" "$REPO/packages/server/src/main.ts"
  local daily='  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
'
  write_plist "$LABEL_PREFIX.backup" "" "$daily" "$HOME_DIR/logs/backup.log" \
    "$(server_env; env_entry BANYAN_BACKUP_DIR "$HOME_DIR/server/backups")" \
    "$TSX" "$REPO/packages/server/scripts/backup.ts"
  load "$LABEL_PREFIX.server"
  load "$LABEL_PREFIX.backup"
  wait_healthy
  if [[ "$DRY_RUN" == 1 ]]; then echo "dry run: plists written to $AGENTS_DIR"; return; fi
  echo "server running at $SERVER_URL (data: $HOME_DIR/server, logs: $HOME_DIR/logs)"
}

register_runner() {
  local room="${1:-}"
  [[ -n "$room" ]] || die "usage: register-runner ROOM"
  [[ -n "${BANYAN_MEMBER_TOKEN:-}" ]] || die "set BANYAN_MEMBER_TOKEN (shown in the room's Invite dialog)"
  BANYAN_HOME="$HOME_DIR" "$TSX" "$REPO/packages/runner/src/main.ts" register --server "$SERVER_URL" --room "$room" --member-token "$BANYAN_MEMBER_TOKEN"
}

install_runner() {
  local room="${1:-}"
  [[ -n "$room" ]] || die "usage: install-runner ROOM"
  [[ -f "$HOME_DIR/rooms/$room/runner.json" ]] || die "no runner registered for room $room; run register-runner first"
  # Restart after crashes but not after a clean stop; throttle restarts when credentials are rejected.
  local restart='  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
'
  write_plist "$LABEL_PREFIX.runner.$room" "$restart" "" "$HOME_DIR/logs/runner-$room.log" \
    "$(env_entry BANYAN_HOME "$HOME_DIR")" \
    "$TSX" "$REPO/packages/runner/src/main.ts" start --room "$room"
  load "$LABEL_PREFIX.runner.$room"
  if [[ "$DRY_RUN" == 1 ]]; then echo "dry run: plist written to $AGENTS_DIR"; return; fi
  echo "runner for room $room started (logs: $HOME_DIR/logs/runner-$room.log)"
}

status() {
  launchctl list | awk -v p="$LABEL_PREFIX." 'NR == 1 || index($3, p) == 1'
  if curl -fsS "$SERVER_URL/api/health" >/dev/null 2>&1; then echo "server: healthy at $SERVER_URL"; else echo "server: not responding at $SERVER_URL"; fi
}

case "${1:-}" in
  install-server) install_server ;;
  uninstall-server)
    unload "$LABEL_PREFIX.server"
    unload "$LABEL_PREFIX.backup"
    echo "server stopped; data kept in $HOME_DIR/server"
    ;;
  register-runner) register_runner "${2:-}" ;;
  install-runner) install_runner "${2:-}" ;;
  uninstall-runner)
    [[ -n "${2:-}" ]] || die "usage: uninstall-runner ROOM"
    unload "$LABEL_PREFIX.runner.$2"
    echo "runner for room $2 stopped"
    ;;
  backup-now) launchctl kickstart "$DOMAIN/$LABEL_PREFIX.backup" && echo "backup started; see $HOME_DIR/logs/backup.log" ;;
  status) status ;;
  logs)
    if [[ -z "${2:-}" || "$2" == "server" ]]; then tail -f "$HOME_DIR/logs/server.log"; else tail -f "$HOME_DIR/logs/runner-$2.log"; fi
    ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' && exit 2 ;;
esac
