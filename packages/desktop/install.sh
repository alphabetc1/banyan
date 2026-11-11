#!/bin/bash
# Installs or updates the Banyan desktop client on macOS (Intel or Apple Silicon) from a room
# server, and points it at that server. Served by the room server as /install.sh:
#   curl -fsSL <server>/install.sh | bash -s <server>
# BANYAN_INSTALL_DIR installs somewhere other than /Applications; BANYAN_INSTALL_LAUNCH=0
# skips opening the client afterwards.
set -euo pipefail

die() { echo "banyan: $*" >&2; exit 1; }

SERVER="${1:-}"
[[ -n "$SERVER" ]] || die "usage: install.sh <room server URL>"
SERVER="${SERVER%/}"
[[ "$(uname -s)" == Darwin ]] || die "the desktop client is for macOS; on Linux run the runner CLI instead"

# uname -m reports x86_64 inside a Rosetta shell even on Apple Silicon, so ask the hardware.
if [[ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" == 1 ]]; then ARCH=arm64; else ARCH=x64; fi

if [[ -n "${BANYAN_INSTALL_DIR:-}" ]]; then DEST="$BANYAN_INSTALL_DIR"
elif [[ -w /Applications ]]; then DEST=/Applications
else DEST="$HOME/Applications"; fi
mkdir -p "$DEST"

TMP="$(mktemp -d)"
trap 'hdiutil detach -quiet "$TMP/mnt" 2>/dev/null || true; rm -rf "$TMP"' EXIT

echo "banyan: downloading the client for $ARCH from $SERVER"
curl -fL --progress-bar -o "$TMP/Banyan.dmg" "$SERVER/downloads/Banyan-$ARCH.dmg" || die "download failed; is $SERVER reachable and does it host the installers?"

# The client quits gracefully on SIGTERM, stopping its runners so they resume after the update.
RUNNING="$DEST/Banyan.app/Contents/MacOS/Banyan"
if pgrep -qf "$RUNNING"; then
  echo "banyan: quitting the running client (its local agents stop and resume after the update)"
  pkill -TERM -f "$RUNNING" || true
  for _ in $(seq 60); do pgrep -qf "$RUNNING" || break; sleep 0.5; done
  pgrep -qf "$RUNNING" && die "the running client did not quit; quit it from the tray and run this again"
fi

hdiutil attach -quiet -nobrowse -readonly -mountpoint "$TMP/mnt" "$TMP/Banyan.dmg"
rm -rf "$DEST/Banyan.app"
ditto "$TMP/mnt/Banyan.app" "$DEST/Banyan.app"
# The app is not signed; a copy made here carries no quarantine flag, but clear any anyway.
xattr -dr com.apple.quarantine "$DEST/Banyan.app" 2>/dev/null || true
echo "banyan: installed $DEST/Banyan.app"

# Agents use the user's own CLIs and logins; point out what is missing rather than fail.
LOGIN_PATH="$("${SHELL:-/bin/zsh}" -ilc 'printf %s "$PATH"' 2>/dev/null || true)"
for tool in git codex; do
  PATH="$LOGIN_PATH:$PATH" command -v "$tool" >/dev/null 2>&1 || echo "banyan: note: '$tool' is not installed; agents that need it will fail"
done
[[ -d "$HOME/.claude" ]] || echo "banyan: note: Claude Code has never been set up on this Mac (no ~/.claude); install it, run 'claude' once and log in"

[[ "${BANYAN_INSTALL_LAUNCH:-1}" == 0 ]] || open -a "$DEST/Banyan.app" --args --server-url="$SERVER"
