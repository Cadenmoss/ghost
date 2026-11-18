#!/bin/bash
# Make upstream StikDebug signable with a FREE Apple ID ("Personal Team").
#
# Free teams can't hold the App Groups entitlement, and StikDebug requests one.
# Every use of it in the code falls back (UserDefaults(suiteName:) ?? .standard,
# guard-let on the container URL), so dropping it only loses a favourites list
# and an icon cache. Location simulation is untouched.
#
# Re-run this after pulling a new StikDebug version.
set -euo pipefail
cd "$(dirname "$0")/StikDebug"
ENT=StikDebug/StikDebug.entitlements
/usr/libexec/PlistBuddy -c "Delete :com.apple.security.application-groups" "$ENT" 2>/dev/null || true
echo "entitlements now:"; plutil -p "$ENT"

# Your own bundle ID (upstream's belongs to StikDebug's developer and is taken),
# and no hardcoded team: Xcode fills in yours when you pick it once.
PBX=StikDebug.xcodeproj/project.pbxproj
sed -i '' 's/PRODUCT_BUNDLE_IDENTIFIER = com.stik.stikdebug;/PRODUCT_BUNDLE_IDENTIFIER = com.caden.ghost.stikdebug;/' "$PBX"
sed -i '' 's/DEVELOPMENT_TEAM = SZ977XLF24;/DEVELOPMENT_TEAM = "";/' "$PBX"
grep -E "PRODUCT_BUNDLE_IDENTIFIER = com.caden|DEVELOPMENT_TEAM" "$PBX" | sort -u

# ghost's Shortcuts actions (Reconnect Device / Simulate Location / Clear
# Simulated Location). The project uses synchronized folders, so a file placed
# in the source tree is compiled automatically.
mkdir -p StikDebug/Ghost
cp ../patches/GhostIntents.swift StikDebug/Ghost/GhostIntents.swift
echo "ghost intents installed"
