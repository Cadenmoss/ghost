/**
 * Trip planning: "from here, to there, take this long."
 *
 * Geocodes both endpoints, asks OSRM for a route that follows real roads, then
 * derives the speed from your chosen duration rather than the other way round —
 * so the phone arrives when you said it would.
 */
const UA = "ghost-location-sim/1.0 (personal use)";

/** Minutes from "90", "1h30m", "1.5h", "45 min", "2 hours". */
function parseDuration(input) {
  if (typeof input === "number" && isFinite(input)) return input;
  const s = String(input ?? "").trim().toLowerCase();
  if (!s) throw new Error("how long should the trip take?");
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s); // bare number means minutes

  let total = 0;
  let matched = false;
  const h = s.match(/(\d+(?:\.\d+)?)\s*h/);
  if (h) {
    total += parseFloat(h[1]) * 60;
    matched = true;
  }
  const m = s.match(/(\d+(?:\.\d+)?)\s*m/);
  if (m) {
    total += parseFloat(m[1]);
    matched = true;
  }
  if (!matched) throw new Error(`could not read a duration from "${input}"`);
  return total;
}

async function getJson(url, label) {
  const res = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en" } });
  if (!res.ok) throw new Error(`${label} failed (${res.status})`);
  return res.json();
}

/** One place name -> a coordinate. */
async function geocode(query) {
  const q = String(query ?? "").trim();
  if (!q) throw new Error("missing address");

  // "37.77, -122.41" is already a coordinate; don't bother the geocoder.
  const pair = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (pair) return { lat: +pair[1], lon: +pair[2], name: q };

  const hits = await getJson(
    `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
    "address lookup"
  );
  if (!hits.length) throw new Error(`no place found for "${q}"`);
  return { lat: +hits[0].lat, lon: +hits[0].lon, name: hits[0].display_name };
}

/** A road-following path between two coordinates. */
async function roadRoute(from, to) {
  const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
  const data = await getJson(
    `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`,
    "route lookup"
  );
  if (data.code !== "Ok" || !data.routes?.length) {
    throw new Error("no road route between those two places");
  }
  const route = data.routes[0];
  return {
    points: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]), // OSRM is lon,lat
    distanceM: route.distance,
    drivingMinutes: route.duration / 60,
  };
}

/**
 * Plan a trip. Returns everything the route runner needs plus a human summary.
 */
async function planTrip({ from, to, duration }) {
  const minutes = parseDuration(duration);
  if (minutes <= 0) throw new Error("duration must be more than zero");

  const [a, b] = await Promise.all([geocode(from), geocode(to)]);
  const road = await roadRoute(a, b);

  const km = road.distanceM / 1000;
  const speedKmh = km / (minutes / 60);

  return {
    points: road.points,
    speedKmh,
    distanceKm: km,
    minutes,
    from: a,
    to: b,
    drivingMinutes: road.drivingMinutes,
    // Surfaced rather than rejected: the user may well want an implausible speed.
    implausible: speedKmh > 200 ? "faster than a car" : speedKmh < 0.5 ? "slower than a walk" : null,
  };
}

module.exports = { planTrip, parseDuration, geocode, roadRoute };
