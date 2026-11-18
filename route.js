/* ------------------------------------------------------------ route walk */

const R_EARTH = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function haversine(a, b) {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

/** Point `frac` of the way along the great circle from a to b. */
function interpolate(a, b, frac) {
  const d = haversine(a, b) / R_EARTH;
  if (d === 0) return a.slice();
  const [lat1, lon1] = [toRad(a[0]), toRad(a[1])];
  const [lat2, lon2] = [toRad(b[0]), toRad(b[1])];
  const A = Math.sin((1 - frac) * d) / Math.sin(d);
  const B = Math.sin(frac * d) / Math.sin(d);
  const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
  const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
  const z = A * Math.sin(lat1) + B * Math.sin(lat2);
  return [toDeg(Math.atan2(z, Math.hypot(x, y))), toDeg(Math.atan2(y, x))];
}

/** Offset a point by a random amount up to `meters`, to avoid a robotic straight line. */
function jitter(point, meters) {
  if (!meters) return point;
  const bearing = Math.random() * 2 * Math.PI;
  const dist = Math.random() * meters;
  const dLat = (dist * Math.cos(bearing)) / R_EARTH;
  const dLon = (dist * Math.sin(bearing)) / (R_EARTH * Math.cos(toRad(point[0])));
  return [point[0] + toDeg(dLat), point[1] + toDeg(dLon)];
}

class RouteRunner {
  constructor(agent) {
    this.agent = agent;
    this.timer = null;
    this.info = null;
  }

  get running() {
    return this.timer !== null;
  }

  /**
   * Position `metres` along the polyline, measured from the first point.
   * Walking a single scalar keeps legs shorter than one tick from stalling
   * the pin — the search simply skips past them.
   */
  static positionAt(points, cum, metres) {
    const total = cum[cum.length - 1];
    if (metres <= 0) return points[0];
    if (metres >= total) return points[points.length - 1];
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < metres) i++;
    const segLen = cum[i + 1] - cum[i];
    return segLen <= 0 ? points[i] : interpolate(points[i], points[i + 1], (metres - cum[i]) / segLen);
  }

  /**
   * Map total distance walked onto a position along the route.
   * Reversing is a triangle wave over 2x the route length, so a single tick may
   * safely span several legs or bounce off an end without special-casing.
   */
  static project(dist, total, { loop, pingPong }) {
    if (pingPong) {
      const period = 2 * total;
      const p = ((dist % period) + period) % period;
      return { metres: p <= total ? p : period - p, done: false };
    }
    if (loop) return { metres: ((dist % total) + total) % total, done: false };
    return { metres: Math.min(dist, total), done: dist >= total };
  }

  start({ points, speedKmh = 5, loop = false, pingPong = false, jitterM = 0, intervalMs = 1000 }) {
    this.stop({ silent: true });
    if (!points || points.length < 2) throw new Error("a route needs at least 2 points");

    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + haversine(points[i - 1], points[i]));
    const total = cum[cum.length - 1];
    if (total <= 0) throw new Error("route has zero length");

    const metresPerTick = ((speedKmh * 1000) / 3600) * (intervalMs / 1000);
    let dist = 0;

    this.info = { points, speedKmh, loop, pingPong, jitterM, total, travelled: 0 };

    this.timer = setInterval(async () => {
      dist += metresPerTick;
      const { metres, done } = RouteRunner.project(dist, total, { loop, pingPong });
      const pos = RouteRunner.positionAt(points, cum, metres);
      this.info.travelled = dist;

      await this.emit(pos, jitterM);
      if (!this.running) return; // emit() may have stopped us on error

      if (done) {
        this.stop({ silent: true });
        this.agent.broadcast({ event: "route", status: "finished" });
        return;
      }
      this.agent.broadcast({
        event: "route",
        status: "running",
        lat: pos[0],
        lon: pos[1],
        travelled: dist,
        total,
      });
    }, intervalMs);

    return this.info;
  }

  async emit(pos, jitterM) {
    const p = jitter(pos, jitterM);
    try {
      await this.agent.send("set", { lat: p[0], lon: p[1] }, 15000);
    } catch (e) {
      this.agent.broadcast({ event: "log", message: `route stopped: ${e.message}` });
      this.stop();
    }
  }

  /** Always tells the UI, so a route stopped from elsewhere can't leave stale buttons. */
  stop({ silent = false } = {}) {
    const was = this.running;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (was && !silent) this.agent.broadcast({ event: "route", status: "stopped" });
  }
}

module.exports = { haversine, interpolate, jitter, RouteRunner };
