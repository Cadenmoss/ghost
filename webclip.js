#!/usr/bin/env node
/**
 * Build a Web Clip configuration profile: a real Home Screen icon that opens
 * ghost full-screen, with no Safari chrome and no key to type.
 *
 * Defaults to the tailnet address so the icon works away from home too.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4577);

function token() {
  try {
    return fs.readFileSync(path.join(ROOT, ".ghost-token"), "utf8").trim();
  } catch {
    console.error("No .ghost-token yet — start ghost with --lan once, then rerun.");
    process.exit(1);
  }
}

/** Prefer the tailnet address: it works at home AND away. */
function hostAddress() {
  if (process.argv[2]) return process.argv[2];
  const all = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) all.push(a.address);
    }
  }
  return all.find((a) => a.startsWith("100.")) || all[0];
}

const host = hostAddress();
if (!host) {
  console.error("No usable network address found.");
  process.exit(1);
}

const url = `http://${host}:${PORT}/?k=${token()}`;
const icon = fs.readFileSync(path.join(ROOT, "icon.png")).toString("base64");
const uuid = () => crypto.randomUUID().toUpperCase();

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key><string>com.apple.webClip.managed</string>
      <key>PayloadIdentifier</key><string>dev.ghost.webclip</string>
      <key>PayloadUUID</key><string>${uuid()}</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadDisplayName</key><string>ghost</string>
      <key>Label</key><string>ghost</string>
      <key>URL</key><string>${url}</string>
      <key>Icon</key>
      <data>${icon}</data>
      <key>IsRemovable</key><true/>
      <key>FullScreen</key><true/>
      <key>Precomposed</key><true/>
      <key>IgnoreManifestScope</key><true/>
    </dict>
  </array>
  <key>PayloadDisplayName</key><string>ghost</string>
  <key>PayloadDescription</key><string>Home Screen icon for the ghost location simulator</string>
  <key>PayloadOrganization</key><string>ghost</string>
  <key>PayloadIdentifier</key><string>dev.ghost.profile</string>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${uuid()}</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadRemovalDisallowed</key><false/>
</dict>
</plist>
`;

const out = path.join(ROOT, "ghost.mobileconfig");
fs.writeFileSync(out, plist, { mode: 0o600 }); // embeds the key
console.log(`  wrote ${out}`);
console.log(`  icon opens: http://${host}:${PORT}${host.startsWith("100.") ? "  (tailnet — works anywhere)" : ""}`);
