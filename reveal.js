#!/usr/bin/env node
/* Unhide the Developer Mode row in Settings > Privacy & Security. */
const { spawnSync } = require("child_process");
const path = require("path");
const os = require("os");

const pythons = [
  process.env.GHOST_PYTHON,
  path.join(os.homedir(), "Library/Application Support/pipx/venvs/pymobiledevice3/bin/python"),
  path.join(os.homedir(), ".local/pipx/venvs/pymobiledevice3/bin/python"),
  path.join(os.homedir(), ".local/share/pipx/venvs/pymobiledevice3/bin/python"),
  "python3",
].filter(Boolean);

const python = pythons.find(
  (py) => spawnSync(py, ["-c", "import pymobiledevice3"], { stdio: "ignore" }).status === 0
);

if (!python) {
  console.error("\n  pymobiledevice3 not installed:  brew install pipx && pipx install pymobiledevice3\n");
  process.exit(1);
}

const cli = python === "python3" ? "pymobiledevice3" : path.join(path.dirname(python), "pymobiledevice3");
const r = spawnSync(cli, ["amfi", "reveal-developer-mode"], { encoding: "utf8", timeout: 20000 });

if (r.status === 0) {
  console.log("\n  \x1b[32m✓\x1b[0m Revealed. On the iPhone:");
  console.log("     Settings > Privacy & Security > Developer Mode > On");
  console.log("     Then reboot the phone and reconnect.\n");
} else {
  const msg = ((r.stdout || "") + (r.stderr || "")).trim().split("\n").pop();
  console.error(`\n  \x1b[31m✗\x1b[0m ${msg || "failed"}`);
  console.error("     Unlock the iPhone, tap Trust if asked, and try again.\n");
  process.exit(1);
}
