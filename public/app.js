/* ghost — front end */

const $ = (id) => document.getElementById(id);

// The key arrives once as ?k=… (from the terminal or a QR scan) and is kept so
// the phone doesn't need it in the URL again.
const KEY = (() => {
  const fromUrl = new URLSearchParams(location.search).get("k");
  if (fromUrl) {
    try { localStorage.setItem("ghost.key", fromUrl); } catch {}
    // The key deliberately STAYS in the address bar. "Add to Home Screen" saves
    // whatever URL is showing, and an iOS home-screen app gets its own storage
    // separate from Safari's — strip the key here and the installed icon opens
    // a page that can never authenticate.
    return fromUrl;
  }
  try { return localStorage.getItem("ghost.key") || ""; } catch { return ""; }
})();

const api = async (path, body) => {
  const res = await fetch("/api" + path, {
    method: body ? "POST" : "GET",
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(KEY ? { "x-ghost-key": KEY } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (res.status === 401) {
    showNeedKey();
    throw Object.assign(new Error("this device has no key"), { hint: data.hint });
  }
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { hint: data.hint });
  return data;
};

function showNeedKey() {
  if (document.getElementById("needkey")) return;
  const el = document.createElement("div");
  el.id = "needkey";
  el.innerHTML = `
    <div class="nk-card">
      <h2>This device isn't set up yet</h2>
      <p>ghost needs its access key, and this browser doesn't have one.</p>
      <ol>
        <li>On the Mac, open <b>http://localhost:4577/qr</b></li>
        <li>Scan the <b>Tailscale</b> code with your camera</li>
        <li>Then <b>Share → Add to Home Screen</b> again</li>
      </ol>
      <p class="nk-note">If you already have a ghost icon, delete it first — it
      was saved without the key.</p>
    </div>`;
  document.body.appendChild(el);
}

/* --------------------------------------------------------------- logging */

function log(msg, cls = "") {
  const el = $("log");
  const time = new Date().toLocaleTimeString([], { hour12: false });
  const line = document.createElement("div");
  line.className = cls;
  line.textContent = `${time}  ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  while (el.childElementCount > 300) el.firstChild.remove();
}

/* ------------------------------------------------------------------- map */

const map = L.map("map", { zoomControl: false, attributionControl: true }).setView([37.7749, -122.4194], 13);
L.control.zoom({ position: "topright" }).addTo(map);

// Esri's dark canvas: keyless, and the labels ship as a separate overlay so the
// basemap stays legible under the route line.
L.tileLayer(
  "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 16, attribution: "© Esri · © OpenStreetMap contributors" }
).addTo(map);
L.tileLayer(
  "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 16, opacity: 0.9 }
).addTo(map);

const pinIcon = L.divIcon({ className: "", html: '<div class="ghost-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
const wpIcon = L.divIcon({ className: "", html: '<div class="wp-pin"></div>', iconSize: [12, 12], iconAnchor: [6, 6] });

let pin = null;          // the spoofed position
let target = null;       // where the user clicked, not yet applied
let routeMode = false;
let waypoints = [];
let wpMarkers = [];
let routeLine = null;

function placePin(lat, lon, pan = false) {
  if (!pin) pin = L.marker([lat, lon], { icon: pinIcon }).addTo(map);
  else pin.setLatLng([lat, lon]);
  if (pan) map.panTo([lat, lon]);
  const text = `${(+lat).toFixed(5)}, ${(+lon).toFixed(5)}`;
  $("hudCoord").textContent = text;
  const mini = $("miniCoord");
  if (mini) mini.textContent = text;
}

function setTarget(lat, lon) {
  target = [lat, lon];
  $("lat").value = (+lat).toFixed(6);
  $("lon").value = (+lon).toFixed(6);
  placePin(lat, lon);
}

map.on("click", (e) => {
  const { lat, lng } = e.latlng;
  if (routeMode) addWaypoint(lat, lng);
  else setTarget(lat, lng);
});

/* --------------------------------------------------------------- route */

function addWaypoint(lat, lon) {
  waypoints.push([lat, lon]);
  const m = L.marker([lat, lon], { icon: wpIcon }).addTo(map);
  m.on("click", () => {
    const i = wpMarkers.indexOf(m);
    if (i >= 0) { waypoints.splice(i, 1); wpMarkers.splice(i, 1); map.removeLayer(m); drawRoute(); }
  });
  wpMarkers.push(m);
  drawRoute();
}

function drawRoute() {
  if (routeLine) map.removeLayer(routeLine);
  routeLine = waypoints.length > 1
    ? L.polyline(waypoints, { color: "#ffb84d", weight: 3, opacity: 0.8, dashArray: "6 6" }).addTo(map)
    : null;
  $("btnRouteStart").disabled = waypoints.length < 2 || !state.connected;
  $("routePill").style.display = waypoints.length ? "inline-flex" : "none";
  $("routePill").textContent = `${waypoints.length} pts`;
}

function clearRoute() {
  waypoints = [];
  wpMarkers.forEach((m) => map.removeLayer(m));
  wpMarkers = [];
  drawRoute();
}

/* -------------------------------------------------------------- devices */

let state = { connected: false };

function render() {
  const on = state.connected;
  const busyNow = state.reconnecting;
  // "held" = the session is alive but the phone has left Wi-Fi, so it cannot be
  // reopened if lost. Looks like "live" but means something very different when
  // you are standing on a street: don't let them read the same.
  const held = state.held;
  $("dot").className = "dot" + (busyNow ? " busy" : held ? " warn" : on ? " on" : "");
  $("statusText").textContent = busyNow
    ? "reconnecting"
    : held
    ? "holding"
    : on
    ? "live"
    : "idle";
  $("btnConnect").disabled = on;
  $("btnDisconnect").disabled = !on;
  $("btnSet").disabled = !on;
  $("btnReset").disabled = !on;
  $("btnRouteStart").disabled = !on || waypoints.length < 2;
  $("btnTrip").disabled = !on;
  const base = `<b>${state.name ?? "iPhone"}</b><br>iOS ${state.ios}<br>via <b>${state.transport}</b>`;
  // Waiting to restore a location the user still wants: say so plainly, so a
  // dropped link doesn't look like nothing is happening.
  if (!on && state.desiredLat != null) {
    $("dot").className = "dot busy";
    $("statusText").textContent = "waiting";
    $("deviceInfo").innerHTML =
      `<span style="color:var(--warn)">Holding <b>${state.desiredLat.toFixed(4)}, ${state.desiredLon.toFixed(4)}</b>.
       Your phone isn't reachable right now — it will snap back the moment it joins Wi-Fi.</span>`;
    $("btnReset").disabled = false;
    return;
  }

  $("deviceInfo").innerHTML = on
    ? held
      ? base +
        `<br><span style="color:var(--warn)">Phone is off Wi-Fi. This session still
         works, but if it drops it can't be reopened until the phone rejoins a
         network.</span>`
      : base
    : busyNow
    ? "Link dropped — trying to restore it…"
    : state.reconnectable === false
    ? `<span style="color:var(--bad)">Can't connect: the phone isn't on a Wi-Fi
       network. iOS only accepts new sessions while it's joined to one.</span>`
    : "No device connected.";
  $("hudMode").textContent = on ? (state.lat != null ? "spoofed" : "connected · real GPS") : "real GPS";
}

function busy(text) {
  $("dot").className = "dot busy";
  $("statusText").textContent = text;
}

$("btnConnect").onclick = async () => {
  busy("connecting");
  log("connecting to device…");
  try {
    state = await api("/connect", {});
    log(`connected: ${state.name} (iOS ${state.ios})`, "ok");
  } catch (e) {
    $("dot").className = "dot err";
    $("statusText").textContent = "error";
    log(e.message, "err");
    if (e.hint) log("→ " + e.hint, "err");
  }
  render();
};

$("btnDisconnect").onclick = async () => {
  await api("/disconnect", {});
  state = { connected: false };
  log("disconnected — device is back on real GPS");
  render();
};

$("btnSet").onclick = async () => {
  const lat = parseFloat($("lat").value);
  const lon = parseFloat($("lon").value);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return log("enter a valid latitude and longitude", "err");
  try {
    await api("/set", { lat, lon });
    state.lat = lat; state.lon = lon;
    placePin(lat, lon, true);
    log(`location set to ${lat.toFixed(5)}, ${lon.toFixed(5)}`, "ok");
    render();
  } catch (e) {
    log(e.message, "err");
  }
};

$("btnReset").onclick = async () => {
  await api("/clear", {});
  state.lat = state.lon = null;
  log("cleared — real GPS restored", "ok");
  render();
};

/* ------------------------------------------------------------ favourites */

const FAVS = "ghost.favs";
const favs = () => JSON.parse(localStorage.getItem(FAVS) || "[]");
const saveFavs = (v) => localStorage.setItem(FAVS, JSON.stringify(v));

function renderFavs() {
  const list = favs();
  const ul = $("favs");
  ul.innerHTML = "";
  if (!list.length) {
    ul.innerHTML = '<li class="empty" style="background:none;padding:0">Nothing saved yet.</li>';
    return;
  }
  list.forEach((f, i) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = f.name;
    name.title = `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}`;
    name.onclick = () => { setTarget(f.lat, f.lon); map.setView([f.lat, f.lon], 14); };
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "✕";
    x.onclick = () => { const l = favs(); l.splice(i, 1); saveFavs(l); renderFavs(); };
    li.append(name, x);
    ul.appendChild(li);
  });
}

$("btnSave").onclick = () => {
  const lat = parseFloat($("lat").value);
  const lon = parseFloat($("lon").value);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return log("pick a point on the map first", "err");
  const name = prompt("Name this spot:", `${lat.toFixed(3)}, ${lon.toFixed(3)}`);
  if (!name) return;
  saveFavs([...favs(), { name, lat, lon }]);
  renderFavs();
};

/* ---------------------------------------------------------------- search */

let searchTimer;
$("search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 3) return ($("results").style.display = "none");
  searchTimer = setTimeout(() => geocode(q), 400);
});

async function geocode(q) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`,
      { headers: { "Accept-Language": "en" } }
    );
    const hits = await res.json();
    const box = $("results");
    box.innerHTML = "";
    if (!hits.length) return (box.style.display = "none");
    hits.forEach((h) => {
      const d = document.createElement("div");
      d.textContent = h.display_name;
      d.onclick = () => {
        setTarget(+h.lat, +h.lon);
        map.setView([+h.lat, +h.lon], 15);
        box.style.display = "none";
        $("search").value = "";
      };
      box.appendChild(d);
    });
    box.style.display = "block";
  } catch {
    log("search failed (no internet?)", "err");
  }
}

/* ----------------------------------------------------------- route ctrls */

$("btnRouteMode").onclick = () => {
  routeMode = !routeMode;
  $("btnRouteMode").textContent = routeMode ? "✓ Click map to add points" : "Draw route on map";
  $("btnRouteMode").classList.toggle("primary", routeMode);
};

$("btnRouteClear").onclick = clearRoute;

$("btnRouteStart").onclick = async () => {
  try {
    await api("/route/start", {
      points: waypoints,
      speedKmh: parseFloat($("speed").value),
      jitterM: parseFloat($("jitter").value) || 0,
      loop: $("loop").checked,
      pingPong: $("pingPong").checked,
    });
    $("btnRouteStop").disabled = false;
    $("btnRouteStart").disabled = true;
    log(`route started · ${$("speed").selectedOptions[0].text}`, "ok");
  } catch (e) {
    log(e.message, "err");
  }
};

$("btnRouteStop").onclick = async () => {
  await api("/route/stop", {});
  log("route stopped");
};

/* ------------------------------------------------------------------ trip */
// "From A to B in N minutes": the road shape comes from OSRM, and the speed is
// whatever makes the trip take exactly as long as you asked.
let tripLine = null;

$("btnTrip").onclick = async () => {
  const from = $("tripFrom").value.trim();
  const to = $("tripTo").value.trim();
  const duration = $("tripTime").value.trim();
  if (!from || !to || !duration) return log("fill in from, to, and how long", "err");

  const btn = $("btnTrip");
  btn.disabled = true;
  btn.textContent = "Planning…";
  try {
    const t = await api("/route/plan", { from, to, duration });

    if (tripLine) map.removeLayer(tripLine);
    tripLine = L.polyline(t.shape, { color: "#4da3ff", weight: 4, opacity: 0.85 }).addTo(map);
    map.fitBounds(tripLine.getBounds(), { padding: [40, 40] });

    $("tripInfo").hidden = false;
    $("tripInfo").innerHTML =
      `<b>${t.distanceKm.toFixed(1)} km</b> in <b>${t.minutes} min</b> — ${t.speedKmh.toFixed(0)} km/h` +
      (t.implausible ? `<br><span style="color:var(--warn)">${t.implausible}</span>` : "") +
      `<br>${t.from.split(",")[0]} → ${t.to.split(",")[0]}`;

    $("btnRouteStop").disabled = false;
    log(`trip started: ${t.distanceKm.toFixed(1)} km at ${t.speedKmh.toFixed(0)} km/h`, "ok");
  } catch (e) {
    log(e.message, "err");
    if (e.hint) log("→ " + e.hint, "err");
  }
  btn.textContent = "Drive it";
  btn.disabled = !state.connected;
};

/* --------------------------------------------------------- revert timer */
// A spoofed location shouldn't outlive your attention: the server reverts the
// phone to real GPS after the configured window. This just visualises it.
let revertAt = null;

function fmtLeft(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}:${String(sec).padStart(2, "0")}`;
}

function renderRevert() {
  const box = $("revert");
  if (!box) return;
  if (!revertAt) {
    box.hidden = true;
    return;
  }
  const left = revertAt - Date.now();
  if (left <= 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.classList.toggle("soon", left < 10 * 60 * 1000);
  $("revertLeft").textContent = fmtLeft(left);
}
setInterval(renderRevert, 1000);

$("btnExtend").onclick = async () => {
  const r = await api("/revert/extend", {});
  revertAt = r.revertAt;
  log("auto-revert restarted");
  renderRevert();
};

$("btnHold").onclick = async () => {
  await api("/revert/cancel", {});
  revertAt = null;
  renderRevert();
  log("auto-revert off — location holds until you stop ghost", "err");
};

/* ------------------------------------------------------------------ feed */

const es = new EventSource("/api/events" + (KEY ? `?k=${encodeURIComponent(KEY)}` : ""));
es.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.event === "log") log(msg.message, msg.level === "stderr" ? "" : "");
  if (msg.event === "state") { state = { ...state, ...msg.state }; render(); }
  if (msg.event === "revert") {
    revertAt = msg.at;
    if (msg.fired) log("auto-revert: phone is back on real GPS", "ok");
    renderRevert();
  }
  if (msg.event === "route") {
    if (msg.status === "running") {
      placePin(msg.lat, msg.lon);
      $("routePill").textContent = `${Math.round(msg.travelled)} / ${Math.round(msg.total)} m`;
      $("hudMode").textContent = "moving";
    } else if (msg.status === "finished" || msg.status === "stopped") {
      if (msg.status === "finished") log("route finished", "ok");
      $("hudMode").textContent = state.connected ? "spoofed" : "real GPS";
      $("btnRouteStop").disabled = true;
      $("btnRouteStart").disabled = !state.connected || waypoints.length < 2;
    }
  }
};

/* ------------------------------------------------------------------ init */

renderFavs();
render();
api("/state").then((s) => {
  state = { ...state, ...s };
  revertAt = s.revertAt ?? null;
  if (s.revertHours) $("btnExtend").textContent = `Restart ${s.revertHours}h`;
  if (s.lat) placePin(s.lat, s.lon, true);
  render();
  renderRevert();
}).catch(() => {});
log("ready — connect your iPhone over USB, then hit Connect");


/* ------------------------------------------------------- phone sheet */
// Tapping the header collapses the panel so the map gets the screen.
(() => {
  const side = $("side");
  const header = document.querySelector("header");
  if (!header) return;
  header.addEventListener("click", () => {
    side.classList.toggle("collapsed");
    setTimeout(() => map.invalidateSize(), 250);
  });
  // Start collapsed on a phone: the map is what you want to see first.
  if (window.matchMedia("(max-width: 760px)").matches) {
    side.classList.add("collapsed");
    // Leaflet sizes itself at construction; the sheet changes the map box after
    // that, so it must be told to re-measure or it renders into dead space.
    requestAnimationFrame(() => map.invalidateSize());
    setTimeout(() => map.invalidateSize(), 300);
  }
})();

window.addEventListener("resize", () => map.invalidateSize());
