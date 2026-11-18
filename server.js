#!/usr/bin/env node
/**
 * ghost — local server.
 *
 * Owns two things the browser can't:
 *   1. the long-lived Python agent holding the device session open
 *   2. route playback, which keeps running even if you close the tab
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const os = require("os");

const PORT = Number(process.env.PORT || 4577);
const ROOT = __dirname;

// Binding beyond loopback exposes control of your phone's location to the
// network, so anything non-local carries a shared secret.
const HOST = process.env.GHOST_HOST || (process.argv.includes("--lan") ? "0.0.0.0" : "127.0.0.1");
const LOCAL_ONLY = HOST === "127.0.0.1" || HOST === "localhost";

const TOKEN_FILE = path.join(ROOT, ".ghost-token");
function loadToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return t;
  } catch {}
  const t = require("crypto").randomBytes(16).toString("hex");
  fs.writeFileSync(TOKEN_FILE, t + "\n", { mode: 0o600 });
  return t;
}
const TOKEN = LOCAL_ONLY ? null : loadToken();

function isLoopback(req) {
  const ip = req.socket.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function authorized(req, url) {
  if (LOCAL_ONLY) return true;
  // Someone connecting from the Mac itself is already past every door the key
  // guards; making them paste it into their own browser buys nothing.
  if (isLoopback(req)) return true;
  const given = req.headers["x-ghost-key"] || url.searchParams.get("k");
  if (!given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && require("crypto").timingSafeEqual(a, b);
}

/* ---------------------------------------------------------------- python */

function resolvePython() {
  const candidates = [
    process.env.GHOST_PYTHON,
    path.join(os.homedir(), "Library/Application Support/pipx/venvs/pymobiledevice3/bin/python"),
    path.join(os.homedir(), ".local/pipx/venvs/pymobiledevice3/bin/python"),
    path.join(os.homedir(), ".local/share/pipx/venvs/pymobiledevice3/bin/python"),
    "python3",
  ].filter(Boolean);

  for (const py of candidates) {
    const probe = spawnSync(py, ["-c", "import pymobiledevice3"], { stdio: "ignore" });
    if (probe.status === 0) return py;
  }
  return null;
}

/* ----------------------------------------------------------------- agent */

class Agent {
  constructor(python) {
    this.python = python;
    this.proc = null;
    this.seq = 0;
    this.pending = new Map();
    this.buf = "";
    this.state = { connected: false };
    this.listeners = new Set();
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(this.python, [path.join(ROOT, "agent", "ghost_agent.py")], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.on("data", (chunk) => {
      this.buf += chunk.toString();
      let nl;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (line) this.onLine(line);
      }
    });

    this.proc.stderr.on("data", (d) => {
      const text = d.toString().trim();
      if (text) this.broadcast({ event: "log", message: text, level: "stderr" });
    });

    this.proc.on("exit", (code) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("agent exited"));
      }
      this.pending.clear();
      this.proc = null;
      // Cable yanked mid-route: stop playback rather than respawning the agent
      // once per tick against a device that is no longer there.
      this.onExit?.();
      this.state = { connected: false };
      this.broadcast({ event: "state", state: this.state });
      this.broadcast({ event: "log", message: `agent exited (code ${code})` });
    });
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.ok ? resolve(msg.data) : reject(Object.assign(new Error(msg.error), { hint: msg.hint }));
      return;
    }
    if (msg.event === "state") this.state = msg.state;
    // Mirror the agent's own events into the service log. Without this, a
    // failure that happens while nobody has a browser open leaves no trace.
    if (msg.event === "log") {
      console.log(`[${new Date().toISOString()}] ${msg.message}`);
    } else if (msg.event === "state") {
      const st = msg.state || {};
      console.log(
        `[${new Date().toISOString()}] state: connected=${st.connected}` +
          ` held=${st.held} transport=${st.transportKind ?? "-"}`
      );
    }
    this.broadcast(msg);
  }

  // Commands that need a live session must not silently resurrect a dead agent.
  static SELF_STARTING = new Set(["connect", "devices", "status", "ping"]);

  send(cmd, args = {}, timeoutMs = 180000) {
    if (!this.proc && !Agent.SELF_STARTING.has(cmd)) {
      return Promise.reject(new Error("not connected"));
    }
    this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`'${cmd}' timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (d) => { clearTimeout(timer); resolve(d); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify({ id, cmd, args }) + "\n");
    });
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  broadcast(msg) {
    for (const fn of this.listeners) fn(msg);
  }
}

const { RouteRunner } = require("./route");
const { planTrip } = require("./plan");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "ghost.config.json"), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Safety net: a spoofed location should never outlive your attention.
 *
 * The clock starts when you set a location and restarts on each deliberate
 * change. Route ticks deliberately do NOT restart it — a looping route is
 * exactly the case that would otherwise keep the phone spoofed forever.
 */
class RevertTimer {
  constructor(agent, route, hours) {
    this.agent = agent;
    this.route = route;
    this.ms = Math.max(0, Number(hours) || 0) * 3600 * 1000;
    this.timer = null;
    this.at = null;
  }

  arm() {
    if (!this.ms) return;
    this.disarm(true);
    this.at = Date.now() + this.ms;
    this.timer = setTimeout(() => this.fire(), this.ms);
    this.agent.broadcast({ event: "revert", at: this.at });
  }

  async fire() {
    this.timer = null;
    this.at = null;
    this.route.stop();
    try {
      await this.agent.send("clear", {}, 30000);
      this.agent.broadcast({ event: "log", message: "auto-revert: back on real GPS" });
    } catch (e) {
      this.agent.broadcast({ event: "log", message: `auto-revert failed: ${e.message}` });
    }
    this.agent.broadcast({ event: "revert", at: null, fired: true });
  }

  disarm(quiet = false) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.at = null;
    if (!quiet) this.agent.broadcast({ event: "revert", at: null });
  }
}

/* ---------------------------------------------------------------- server */

const python = resolvePython();
const agent = python ? new Agent(python) : null;
const route = agent ? new RouteRunner(agent) : null;
const CONFIG = loadConfig();
const revert = agent ? new RevertTimer(agent, route, CONFIG.autoRevertHours ?? 12) : null;
if (agent) {
  agent.onExit = () => {
    route.stop();
    revert.disarm(true);
  };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
};

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 5e6) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route_ = url.pathname;

  try {
    // Onboarding page: shows the phone links + a QR to scan. Restricted to
    // loopback — if you can load it, you are already at the Mac.
    if (route_ === "/qr") {
      if (!isLoopback(req)) return json(res, 403, { error: "open this on the Mac itself" });

      const links = [];
      for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
        for (const a of addrs || []) {
          if (a.family !== "IPv4" || a.internal) continue;
          if (a.address.startsWith("169.254.")) continue; // self-assigned, unreachable
          const tailnet = a.address.startsWith("100.");
          links.push({
            name: tailnet ? "Tailscale — works anywhere" : `${name} — same Wi-Fi only`,
            url: `http://${a.address}:${PORT}/${TOKEN ? `?k=${TOKEN}` : ""}`,
            tailnet,
          });
        }
      }
      links.sort((a, b) => Number(b.tailnet) - Number(a.tailnet));
      // One remote option and one local fallback is all anyone needs.
      const trimmed = [];
      for (const l of links) {
        if (l.tailnet || !trimmed.some((t) => !t.tailnet)) trimmed.push(l);
      }
      links.length = 0;
      links.push(...trimmed);

      const page = fs.readFileSync(path.join(ROOT, "public", "qr.html"), "utf8")
        .replace("__LINKS__", JSON.stringify(links));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(page);
    }

    // The Web Clip profile embeds the key, so it is guarded like the API.
    if (route_ === "/ghost.mobileconfig") {
      if (!authorized(req, url)) return json(res, 401, { error: "unauthorized" });
      let file;
      try {
        file = fs.readFileSync(path.join(ROOT, "ghost.mobileconfig"));
      } catch {
        return json(res, 404, { error: "not generated yet — run: node webclip.js" });
      }
      res.writeHead(200, {
        "content-type": "application/x-apple-aspen-config",
        "content-disposition": 'attachment; filename="ghost.mobileconfig"',
      });
      return res.end(file);
    }

    if (route_.startsWith("/api/") && !authorized(req, url)) {
      return json(res, 401, {
        error: "unauthorized",
        hint: `This device has no key. On the Mac open http://localhost:${PORT}/qr and scan the code.`,
      });
    }

    if (route_ === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ event: "hello", state: agent?.state ?? {} })}\n\n`);
      const unsub = agent.subscribe((msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`));
      const beat = setInterval(() => res.write(": beat\n\n"), 20000);
      req.on("close", () => { unsub(); clearInterval(beat); });
      return;
    }

    if (route_.startsWith("/api/")) {
      if (!agent) {
        return json(res, 503, {
          error: "pymobiledevice3 not found",
          hint: "Install it with:  brew install pipx && pipx install pymobiledevice3",
        });
      }

      const body = req.method === "POST" ? await readBody(req) : {};

      switch (route_) {
        case "/api/state":
          return json(res, 200, {
            ...(await agent.send("status")),
            route: route.running ? route.info : null,
            revertAt: revert.at,
            revertHours: CONFIG.autoRevertHours ?? 12,
          });
        case "/api/devices":
          return json(res, 200, await agent.send("devices", {}, 30000));
        case "/api/connect":
          return json(res, 200, await agent.send("connect", { transport: body.transport }, 300000));
        case "/api/disconnect":
          route.stop();
          revert.disarm();
          return json(res, 200, await agent.send("disconnect"));
        case "/api/set": {
          route.stop();
          const set = await agent.send("set", { lat: body.lat, lon: body.lon }, 20000);
          revert.arm();
          return json(res, 200, set);
        }
        case "/api/clear":
          route.stop();
          revert.disarm();
          return json(res, 200, await agent.send("clear"));
        case "/api/revert/extend":
          revert.arm();
          return json(res, 200, { revertAt: revert.at });
        case "/api/revert/cancel":
          revert.disarm();
          return json(res, 200, { revertAt: null });
        case "/api/route/start": {
          const live = await agent.send("status");
          if (!live.connected) {
            return json(res, 409, {
              error: "not connected",
              hint: "Connect the iPhone before starting a route.",
            });
          }
          const started = route.start(body);
          revert.arm();
          return json(res, 200, started);
        }
        case "/api/route/plan": {
          const live = await agent.send("status");
          if (!live.connected) {
            return json(res, 409, { error: "not connected", hint: "Connect the iPhone first." });
          }
          const trip = await planTrip(body);
          route.start({
            points: trip.points,
            speedKmh: trip.speedKmh,
            jitterM: body.jitterM ?? 2,
            loop: false,
            pingPong: false,
          });
          revert.arm();
          return json(res, 200, {
            from: trip.from.name,
            to: trip.to.name,
            distanceKm: trip.distanceKm,
            minutes: trip.minutes,
            speedKmh: trip.speedKmh,
            points: trip.points.length,
            implausible: trip.implausible,
            shape: trip.points,
          });
        }
        case "/api/route/stop":
          route.stop();
          return json(res, 200, { stopped: true });
        default:
          return json(res, 404, { error: "no such endpoint" });
      }
    }

    // static files
    const rel = route_ === "/" ? "index.html" : route_.replace(/^\/+/, "");
    const file = path.join(ROOT, "public", rel);
    if (!file.startsWith(path.join(ROOT, "public"))) return json(res, 403, { error: "nope" });

    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  } catch (e) {
    json(res, 500, { error: e.message, hint: e.hint });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  ghost  →  http://localhost:${PORT}`);
  if (!LOCAL_ONLY) {
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === "IPv4" && !a.internal) {
          console.log(`  phone  →  http://${a.address}:${PORT}/?k=${TOKEN}   (${name})`);
        }
      }
    }
  }
  if (!LOCAL_ONLY) console.log(`\n  Scan a QR to set up the phone:  http://localhost:${PORT}/qr`);
  console.log("");
  if (!python) {
    console.log("  ⚠  pymobiledevice3 not found. Install:");
    console.log("     brew install pipx && pipx install pymobiledevice3\n");
  } else {
    console.log(`  python: ${python}\n`);
  }
});

function shutdown() {
  route?.stop();
  if (agent?.proc) {
    agent.send("disconnect").catch(() => {});
    setTimeout(() => { agent.proc?.kill(); process.exit(0); }, 600);
  } else {
    process.exit(0);
  }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
