/* Checks the route maths without a device: a stub agent records every coordinate. */
const assert = require("assert");
const { haversine, interpolate, RouteRunner } = require("./route");

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
};

const SF = [37.7749, -122.4194];
const OAK = [37.8044, -122.2712];

check("haversine matches known SF→Oakland distance (~13.4 km)", () => {
  const d = haversine(SF, OAK);
  assert(d > 13000 && d < 14000, `got ${Math.round(d)} m`);
});

check("haversine is zero for identical points", () => {
  assert.strictEqual(haversine(SF, SF), 0);
});

check("interpolate at 0 and 1 hits the endpoints", () => {
  const a = interpolate(SF, OAK, 0), b = interpolate(SF, OAK, 1);
  assert(haversine(a, SF) < 1, "start");
  assert(haversine(b, OAK) < 1, "end");
});

check("interpolate midpoint is half the distance from each end", () => {
  const mid = interpolate(SF, OAK, 0.5);
  const d1 = haversine(SF, mid), d2 = haversine(mid, OAK);
  assert(Math.abs(d1 - d2) < 1, `${d1} vs ${d2}`);
});

/* --- runner --- */
function stub() {
  const seen = [];
  return {
    seen,
    agent: { send: async (cmd, args) => { if (cmd === "set") seen.push([args.lat, args.lon]); }, broadcast() {} },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 3600 km/h = 1 km per tick at 1 s; use a fast tick to keep the test quick.
  const s = stub();
  const r = new RouteRunner(s.agent);
  r.start({ points: [SF, OAK], speedKmh: 36, intervalMs: 50, jitterM: 0 });
  await wait(400);
  r.stop();

  check("runner emits coordinates while running", () => {
    assert(s.seen.length >= 5, `only ${s.seen.length} points`);
  });

  check("emitted points advance along the route, not teleport", () => {
    const first = s.seen[0], last = s.seen[s.seen.length - 1];
    assert(haversine(first, SF) < haversine(last, SF), "did not move away from start");
    // every step should be small: 36 km/h * 0.05 s = 0.5 m, allow slack
    for (let i = 1; i < s.seen.length; i++) {
      const step = haversine(s.seen[i - 1], s.seen[i]);
      assert(step < 50, `step ${i} jumped ${step.toFixed(1)} m`);
    }
  });

  check("stop() halts emission", async () => {
    const n = s.seen.length;
    return wait(200).then(() => assert.strictEqual(s.seen.length, n));
  });

  // ping-pong must reverse rather than run off the end
  const s2 = stub();
  const r2 = new RouteRunner(s2.agent);
  const near = [[37.7749, -122.4194], [37.7752, -122.4194]]; // ~33 m apart
  r2.start({ points: near, speedKmh: 36, intervalMs: 20, pingPong: true, jitterM: 0 });
  await wait(500);
  r2.stop();

  check("ping-pong keeps every point inside the route's bounds", () => {
    const lats = s2.seen.map((p) => p[0]);
    const min = Math.min(...lats), max = Math.max(...lats);
    assert(min >= near[0][0] - 1e-4, `wandered south: ${min}`);
    assert(max <= near[1][0] + 1e-4, `wandered north: ${max}`);
    assert(s2.seen.length > 10, "too few samples");
  });

  check("jitter stays within its radius", () => {
    const { jitter } = require("./route");
    for (let i = 0; i < 500; i++) {
      const p = jitter(SF, 10);
      assert(haversine(SF, p) <= 10.5, `${haversine(SF, p)} m`);
    }
  });

  /* --- the cases that broke the first implementation --- */

  // A leg far shorter than one tick must not stall the pin.
  const s3 = stub();
  const r3 = new RouteRunner(s3.agent);
  const tiny = [
    [37.7749, -122.4194],
    [37.77494, -122.4194],   // ~4 m
    [37.775, -122.4194],     // ~7 m further
    [37.79, -122.4194],      // ~1.7 km
  ];
  r3.start({ points: tiny, speedKmh: 3600, intervalMs: 20, jitterM: 0 }); // 20 m/tick: one tick skips both short legs
  await wait(300);
  r3.stop();

  check("a leg shorter than one tick does not stall the route", () => {
    assert(s3.seen.length > 5, `only ${s3.seen.length} samples`);
    const start = tiny[0];
    const d = s3.seen.map((p) => haversine(start, p));
    // must make real progress, not sit on the 4 m waypoint
    assert(Math.max(...d) > 100, `never got past the short legs (max ${Math.max(...d).toFixed(1)} m)`);
    for (let i = 1; i < d.length; i++) assert(d[i] >= d[i - 1] - 0.01, `went backwards at ${i}`);
  });

  // Ping-pong across legs of very different lengths must stay monotonic per pass.
  const s4 = stub();
  const r4 = new RouteRunner(s4.agent);
  const uneven = [
    [37.7749, -122.4194],
    [37.7752, -122.4194],   // ~33 m
    [37.7850, -122.4194],   // ~1.1 km
  ];
  r4.start({ points: uneven, speedKmh: 18000, intervalMs: 20, pingPong: true, jitterM: 0 });
  await wait(600);
  r4.stop();

  check("ping-pong over uneven legs reverses cleanly and stays in bounds", () => {
    const lats = s4.seen.map((p) => p[0]);
    assert(Math.min(...lats) >= uneven[0][0] - 1e-4, `overshot the start: ${Math.min(...lats)}`);
    assert(Math.max(...lats) <= uneven[2][0] + 1e-4, `overshot the end: ${Math.max(...lats)}`);
    // it should actually turn around, not stick at one end
    const turns = s4.seen.slice(1).reduce((n, p, i) => {
      const prev = i > 0 ? Math.sign(s4.seen[i][0] - s4.seen[i - 1][0]) : 0;
      const now = Math.sign(p[0] - s4.seen[i][0]);
      return prev && now && prev !== now ? n + 1 : n;
    }, 0);
    assert(turns >= 1, "never reversed direction");
  });

  check("project() maps distance onto the route correctly", () => {
    const P = (d, o) => RouteRunner.project(d, 100, o).metres;
    assert.strictEqual(P(150, { loop: true }), 50, "loop wraps");
    assert.strictEqual(P(150, { pingPong: true }), 50, "ping-pong reflects");
    assert.strictEqual(P(250, { pingPong: true }), 50, "ping-pong reflects on the second pass");
    assert.strictEqual(P(150, {}), 100, "one-shot clamps to the end");
    assert.strictEqual(RouteRunner.project(150, 100, {}).done, true, "one-shot reports done");
  });

  check("a finished one-shot route stops itself", async () => {
    const s5 = stub();
    const r5 = new RouteRunner(s5.agent);
    r5.start({ points: [SF, [37.7751, -122.4194]], speedKmh: 360, intervalMs: 20, jitterM: 0 });
    return wait(400).then(() => assert(!r5.running, "still running after the end"));
  });

  await wait(500);
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
