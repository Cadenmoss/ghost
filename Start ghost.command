#!/bin/bash
# Double-click this to start ghost.
#
# Keep this window open: the iPhone's fake location lasts only as long as
# ghost is running. Close the window (or press Ctrl-C) to hand the phone
# back to its real GPS.

cd "$(dirname "$0")" || exit 1
PORT="${PORT:-4577}"

# Finder launches this with a bare PATH; Homebrew and nvm live outside it.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

bold=$'\033[1m'; dim=$'\033[90m'; red=$'\033[31m'; grn=$'\033[32m'; yel=$'\033[33m'; off=$'\033[0m'

printf '\n  %sghost%s  %siPhone location simulator%s\n\n' "$bold" "$off" "$dim" "$off"

if ! command -v node >/dev/null 2>&1; then
  printf '  %s✗ Node.js is not installed.%s\n' "$red" "$off"
  printf '    Install it from https://nodejs.org, then double-click this again.\n\n'
  read -r -p "  Press Return to close… "
  exit 1
fi

# Already running? Just bring the window up rather than starting a second copy.
if curl -fsS -m 2 "http://localhost:$PORT/api/state" >/dev/null 2>&1; then
  printf '  %s✓ ghost is already running%s on port %s — opening it.\n\n' "$grn" "$off" "$PORT"
  open "http://localhost:$PORT"
  read -r -p "  Press Return to close this window… "
  exit 0
fi

# Warn early rather than failing at the Connect button.
if ! node doctor.js 2>/dev/null | grep -q "pymobiledevice3 [0-9]"; then
  printf '  %s⚠ pymobiledevice3 is missing.%s The map will load, but Connect will fail.\n' "$yel" "$off"
  printf '    Install it with:  %sbrew install pipx && pipx install pymobiledevice3%s\n\n' "$bold" "$off"
fi

printf '  Opening %shttp://localhost:%s%s\n' "$bold" "$PORT" "$off"
printf '  Phone setup (scan a QR): %shttp://localhost:%s/qr%s\n' "$bold" "$PORT" "$off"
printf '  %sKeep this window open — closing it returns the iPhone to real GPS.%s\n' "$dim" "$off"
printf '  %sPress Ctrl-C to stop.%s\n' "$dim" "$off"

( sleep 1.5; open "http://localhost:$PORT" ) &

# Run the server in the background and wait on it, so a Ctrl-C or a closed
# window reaches the trap instead of being swallowed by a foreground child.
PORT="$PORT" node server.js --lan &
NODE_PID=$!

cleanup() {
  trap '' INT TERM HUP
  # SIGTERM lets server.js clear the simulated location before it goes.
  kill "$NODE_PID" 2>/dev/null
  wait "$NODE_PID" 2>/dev/null
  printf '\n  %sghost stopped — the iPhone is back on its real GPS.%s\n\n' "$dim" "$off"
  exit 0
}
trap cleanup INT TERM HUP

wait "$NODE_PID"
cleanup
