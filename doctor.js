#!/usr/bin/env node
/* ghost doctor — checks every prerequisite and says exactly what to fix. */
const { spawnSync, execSync } = require("child_process");
const path = require("path");
const os = require("os");

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m, fix) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  if (fix) console.log(`     \x1b[33m→ ${fix}\x1b[0m`);
};
const info = (m) => console.log(`     \x1b[90m${m}\x1b[0m`);

console.log("\n  ghost doctor\n");

// 1. node
ok(`Node ${process.version}`);

// 2. python + pymobiledevice3
const candidates = [
  process.env.GHOST_PYTHON,
  path.join(os.homedir(), "Library/Application Support/pipx/venvs/pymobiledevice3/bin/python"),
  path.join(os.homedir(), ".local/pipx/venvs/pymobiledevice3/bin/python"),
  path.join(os.homedir(), ".local/share/pipx/venvs/pymobiledevice3/bin/python"),
  "python3",
].filter(Boolean);

let python = null;
for (const py of candidates) {
  if (spawnSync(py, ["-c", "import pymobiledevice3"], { stdio: "ignore" }).status === 0) {
    python = py;
    break;
  }
}

if (!python) {
  bad("pymobiledevice3 not installed", "brew install pipx && pipx install pymobiledevice3");
  process.exit(1);
}
const ver = spawnSync(python, ["-c", `import importlib.metadata as m; print(m.version("pymobiledevice3"))`], { encoding: "utf8" });
ok(`pymobiledevice3 ${(ver.stdout || "").trim()}`);
info(python);

// 3. devices
const probe = spawnSync(
  python,
  ["-c", `
import asyncio, json
from pymobiledevice3 import usbmux
from pymobiledevice3.lockdown import create_using_usbmux

async def main():
    out = []
    for d in await usbmux.list_devices():
        e = {"udid": d.serial, "conn": d.connection_type}
        try:
            l = await create_using_usbmux(serial=d.serial)
            e["name"] = l.short_info.get("DeviceName")
            e["ios"] = l.product_version
        except Exception as ex:
            e["error"] = str(ex)
        out.append(e)
    print(json.dumps(out))

asyncio.run(main())
`],
  { encoding: "utf8", timeout: 30000 }
);

let devices = [];
try {
  devices = JSON.parse((probe.stdout || "[]").trim().split("\n").pop());
} catch {
  bad("could not talk to usbmuxd", (probe.stderr || "").trim().split("\n").pop());
}

// The Developer Mode row stays hidden until a computer asks the device for a
// developer service, which is the #1 reason "I don't see Developer Mode".
function devModeStatus(cli) {
  const r = spawnSync(cli, ["amfi", "developer-mode-status"], { encoding: "utf8", timeout: 20000 });
  const text = ((r.stdout || "") + (r.stderr || "")).toLowerCase();
  if (text.includes("true")) return true;
  if (text.includes("false")) return false;
  return null;
}

const cli = path.join(path.dirname(python), "pymobiledevice3");

if (!devices.length) {
  bad("no iPhone detected", "Plug the iPhone into this Mac with a cable, unlock it, and tap Trust.");
} else {
  for (const d of devices) {
    if (d.error) {
      bad(`${d.udid} — ${d.error}`, "Unlock the iPhone and tap Trust This Computer, then rerun.");
    } else {
      ok(`${d.name} — iOS ${d.ios} (${d.conn})`);
      const major = parseInt(d.ios, 10);
      info(major >= 17 ? "iOS 17+: uses a RemoteXPC tunnel (no sudo needed on macOS)" : "pre-iOS 17: uses the lockdown developer service");
    }
  }
  const dev = devModeStatus(cli);
  if (dev === true) {
    ok("Developer Mode is on");
  } else if (dev === false) {
    bad("Developer Mode is off");
    const revealed = spawnSync(cli, ["amfi", "reveal-developer-mode"], { timeout: 20000 }).status === 0;
    info(revealed ? "Just revealed the menu entry on your iPhone. Now, on the phone:" : "On the phone:");
    info("  Settings > Privacy & Security > Developer Mode > On");
    info("  then reboot, unlock, and rerun this check.");
  } else {
    info("Could not read Developer Mode status; check it on the phone.");
    info("  Settings > Privacy & Security > Developer Mode");
    info("  Missing? run:  npm run reveal");
  }
}

// An upgrade of pymobiledevice3 is the likeliest way this breaks silently:
// ghost swaps out one of its module-level functions, which is a shim, not an API.
const tested = (() => {
  try { return JSON.parse(require("fs").readFileSync(path.join(__dirname, "tested-with.json"), "utf8")); }
  catch { return {}; }
})();

const compat = spawnSync(python, [path.join(__dirname, "compat-check.py")], { encoding: "utf8", timeout: 30000 });
try {
  const r = JSON.parse((compat.stdout || "{}").trim().split("\n").pop());
  if (r.problems && r.problems.length) {
    bad("pymobiledevice3 changed underneath ghost");
    r.problems.forEach((p) => info("  " + p));
    info(`  roll back with:  pipx install pymobiledevice3==${tested.pymobiledevice3} --force`);
  } else {
    ok("library internals ghost depends on are all present");
  }
  if (tested.pymobiledevice3 && r.version && r.version !== tested.pymobiledevice3) {
    info(`note: verified against pymobiledevice3 ${tested.pymobiledevice3}, running ${r.version}`);
  }
} catch {
  info("could not run the compatibility check");
}

for (const d of devices) {
  if (d.ios && tested.ios && d.ios !== tested.ios) {
    info(`note: verified against iOS ${tested.ios}, phone is on ${d.ios}`);
    info("  if developer services misbehave after an iOS update, re-pair over USB");
  }
}

console.log("\n  Then:  npm start\n");
