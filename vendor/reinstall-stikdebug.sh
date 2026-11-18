#!/bin/bash
# Rebuild and reinstall StikDebug. A free Apple ID signature lasts 7 days;
# run this before it lapses (phone plugged in, unlocked). Your saved locations,
# pairing file and settings survive a reinstall.
set -euo pipefail
cd "$(dirname "$0")"
./prepare-stikdebug.sh >/dev/null   # re-apply free-team fix + ghost Shortcuts actions
PBX=StikDebug/StikDebug.xcodeproj/project.pbxproj
# The team you chose in Xcode. Match the ID on its own, not inside the key name
# (an earlier version of this grabbed "DEVELOPMEN" from DEVELOPMENT_TEAM).
TEAM=$(sed -nE 's/.*DEVELOPMENT_TEAM = ([A-Z0-9]{10});.*/\1/p' "$PBX" | head -1)
[ -z "$TEAM" ] && { echo "No team set — pick it in Xcode: StikDebug target → Signing & Capabilities"; exit 1; }
UDID=$(python3 -c "import json;print(json.load(open('../ghost.config.json'))['udid'])")
OUT="$(mktemp -d)/build"
echo "building for team $TEAM…"
xcodebuild -project StikDebug/StikDebug.xcodeproj -scheme StikDebug -configuration Debug \
  -destination "id=$UDID" -derivedDataPath "$OUT" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$TEAM" build -quiet
APP="$OUT/Build/Products/Debug-iphoneos/StikDebug.app"
xcrun devicectl device install app --device "$UDID" "$APP" >/dev/null
EXP=$(security cms -D -i "$APP/embedded.mobileprovision" | plutil -extract ExpirationDate raw -)
echo "✓ installed — good until $EXP"
