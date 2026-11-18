#!/usr/bin/env bash
# Run ghost as a background service that starts at login and restarts on crash.
#
#   ./service.sh install | uninstall | status | restart | logs
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
LABEL="dev.ghost.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/ghost.log"
ERR="$HOME/Library/Logs/ghost.error.log"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
PORT="${PORT:-4577}"

bold=$'\033[1m'; grn=$'\033[32m'; red=$'\033[31m'; yel=$'\033[33m'; dim=$'\033[90m'; off=$'\033[0m'

write_plist() {
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  # Keep the Mac awake for as long as ghost runs — without this it sleeps after a
  # minute idle and is unreachable the moment you leave. Both flags are needed:
  # -i blocks the idle-sleep timer (the one that would actually fire here) and
  # -s blocks system sleep while on AC. A locked screen is unaffected either way;
  # the assertions disappear when ghost stops, changing nothing permanently.
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-s</string>
    <string>-i</string>
    <string>$NODE</string>
    <string>$ROOT/server.js</string>
    <string>--lan</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$ERR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PORT</key><string>$PORT</string>
  </dict>
</dict>
</plist>
PLIST
}

case "${1:-status}" in
  install)
    # A hand-started copy would hold the port.
    launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
    # bootout is asynchronous; bootstrapping while the old job lingers fails
    # with a bare "Input/output error", so wait for it to actually go.
    for _ in $(seq 1 10); do
      launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 || break
      sleep 1
    done
    pkill -f "node $ROOT/server.js" 2>/dev/null || true
    sleep 1
    write_plist
    launchctl bootstrap "gui/$UID" "$PLIST"
    launchctl enable "gui/$UID/$LABEL"
    # First response is slow: the server probes for python and spawns the agent.
    ready=""
    for _ in $(seq 1 15); do
      sleep 2
      if curl -fsS -m 5 "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1; then ready=1; break; fi
    done
    if [ -n "$ready" ]; then
      printf "  %s✓ ghost is running and will start itself at login%s\n" "$grn" "$off"
      printf "  %sphone setup:%s http://localhost:$PORT/qr\n" "$dim" "$off"
    else
      printf "  %s✗ installed but not answering — check: ./service.sh logs%s\n" "$red" "$off"
      exit 1
    fi
    ;;

  uninstall)
    launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    printf "  %sremoved. ghost no longer starts on its own.%s\n" "$dim" "$off"
    ;;

  restart)
    launchctl kickstart -k "gui/$UID/$LABEL"
    sleep 2
    printf "  restarted\n"
    ;;

  logs)
    printf "  %s%s%s\n" "$dim" "$LOG" "$off"
    tail -n "${2:-40}" "$LOG" "$ERR" 2>/dev/null
    ;;

  status)
    if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
      pid=$(launchctl print "gui/$UID/$LABEL" 2>/dev/null | awk '/^\tpid = /{print $3}')
      printf "  service: %sinstalled%s (pid ${pid:-none})\n" "$grn" "$off"
    else
      printf "  service: %snot installed%s — run: ./service.sh install\n" "$yel" "$off"
    fi
    if curl -fsS -m 5 "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1; then
      printf "  http:    %sanswering on :%s%s\n" "$grn" "$PORT" "$off"
    else
      printf "  http:    %snot answering%s\n" "$red" "$off"
    fi
    # Check for our own caffeinate wrapper rather than parsing pmset, whose
    # snapshot output proved flaky to grep.
    if pgrep -f "caffeinate -s -i .*$ROOT/server.js" >/dev/null 2>&1; then
      printf "  sleep:   %sprevented while ghost runs%s\n" "$grn" "$off"
    else
      printf "  sleep:   %sthis Mac may sleep — ghost would be unreachable%s\n" "$yel" "$off"
    fi
    ;;

  *)
    echo "usage: ./service.sh install | uninstall | status | restart | logs"
    exit 1
    ;;
esac
