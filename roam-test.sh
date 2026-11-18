#!/usr/bin/env bash
# Does a live session survive the phone leaving Wi-Fi for cellular?
#
# This is the single question that decides whether ghost works on cellular.
# The listener iOS shuts down on cellular only gates OPENING a session; an
# already-open socket needs no listener, and a tailnet address is stable across
# network changes. So a session opened on Wi-Fi may keep working on cellular.
#
#   ./roam-test.sh arm     # phone still on Wi-Fi
#   (turn Wi-Fi OFF on the phone)
#   ./roam-test.sh check   # immediately after
#   ./roam-test.sh check   # again 2+ minutes later — this is the real one
set -uo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-4577}"
KEY="$(cat .ghost-token 2>/dev/null || true)"
HOST="$(python3 -c "import json;print(json.load(open('ghost.config.json'))['tailnetHost'])")"
grn=$'\033[32m'; red=$'\033[31m'; yel=$'\033[33m'; dim=$'\033[90m'; off=$'\033[0m'

api() {
  local m=$1 p=$2 b=${3:-}
  curl -s -m 90 -X "$m" -H "x-ghost-key: $KEY" -H 'content-type: application/json' \
    ${b:+-d "$b"} "http://127.0.0.1:$PORT/api$p"
}
field() { python3 -c "import sys,json;print(json.load(sys.stdin).get('$1'))" 2>/dev/null; }

listener() { nc -z -G 8 "$HOST" 62078 >/dev/null 2>&1 && echo open || echo closed; }

case "${1:-check}" in
  arm)
    printf "  connecting while the phone is on Wi-Fi…\n"
    res=$(api POST /connect '{"transport":"tailnet"}')
    st=$(api GET /state)
    if [ "$(echo "$st" | field connected)" != "True" ]; then
      # Report what actually went wrong instead of guessing at the cause.
      err=$(echo "$res" | field error); hint=$(echo "$res" | field hint)
      printf "  %s✗ could not connect%s\n" "$red" "$off"
      [ "$err"  != "None" ] && printf "     %s\n" "$err"
      [ "$hint" != "None" ] && printf "     %s→ %s%s\n" "$yel" "$hint" "$off"
      printf "     %slistener on :62078 is %s%s\n" "$dim" "$(listener)" "$off"
      exit 1
    fi
    api POST /set '{"lat":35.659482,"lon":139.700553}' >/dev/null   # Tokyo
    printf "  %s✓ session open over Tailscale, location set to Tokyo%s\n" "$grn" "$off"
    printf "  %slistener: %s%s\n" "$dim" "$(listener)" "$off"
    printf "\n  Now turn Wi-Fi OFF on the phone, then run: ./roam-test.sh check\n\n"
    ;;

  check)
    l=$(listener)
    printf "  listener on :62078 → %s %s\n" "$l" \
      "$([ "$l" = closed ] && echo "${dim}(phone is off Wi-Fi — good, that's the test)${off}" || echo "${yel}(phone still on Wi-Fi — turn it off first)${off}")"
    st=$(api GET /state)
    conn=$(echo "$st" | field connected)
    printf "  session reports connected=%s held=%s\n" "$conn" "$(echo "$st" | field held)"
    if [ "$conn" != "True" ]; then
      printf "  %s✗ session already dropped — cellular does not survive%s\n" "$red" "$off"; exit 1
    fi
    # The real proof: push a NEW coordinate through the held channel.
    lat=$(python3 -c "import random;print(round(random.uniform(-33.9,-33.8),6))")
    lon=$(python3 -c "import random;print(round(random.uniform(151.1,151.3),6))")
    out=$(api POST /set "{\"lat\":$lat,\"lon\":$lon}")
    if echo "$out" | grep -q '"lat"'; then
      printf "  %s✓ accepted a new coordinate over the held session%s (%s, %s)\n" "$grn" "$off" "$lat" "$lon"
      printf "  %sCheck Maps on the phone — it must actually be in Sydney.%s\n" "$dim" "$off"
      printf "  %sThen run this again in 2+ minutes: a stale TCP path often%s\n" "$dim" "$off"
      printf "  %ssurvives one write and fails on the next.%s\n" "$dim" "$off"
    else
      printf "  %s✗ write failed: %s%s\n" "$red" "$out" "$off"; exit 1
    fi
    ;;

  *) echo "usage: ./roam-test.sh arm | check"; exit 1 ;;
esac
