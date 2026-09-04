// Regression tests for src/lib/smoothRoute.js.
//
//   npm run test:smooth
//
// WHY THIS EXISTS. This code rewrites the geometry the map draws AND the geometry the ship rides,
// and its failures are geometric rather than thrown:
//
//   - Lose the longitude unwrap and a Pacific route streaks straight across the world. These coords
//     deliberately run past +180 (Qingdao -> Los Angeles reaches 241.9) so the line draws east
//     rather than jumping back over Eurasia, and every trigonometric step here returns -180..180.
//   - Move an endpoint and the line stops touching its port.
//   - Cut a corner too hard and the route crosses land. Nothing here knows where the land is; the
//     safety comes entirely from scaling the cut to the segments, so that bound is asserted.
//
// Synthetic geometry throughout, so it runs offline.

import { smoothLane, __test } from '../src/lib/smoothRoute.js'

const { dedupe, densify, chamfer, haversine, MAX_CUT_KM } = __test

let failed = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

/** Shortest distance from p to the polyline, sampling each segment. Enough to bound a deviation. */
function distanceToPath(p, path) {
  let best = Infinity
  for (let i = 0; i < path.length - 1; i += 1) {
    for (let t = 0; t <= 1; t += 0.05) {
      const q = [
        path[i][0] + (path[i + 1][0] - path[i][0]) * t,
        path[i][1] + (path[i + 1][1] - path[i][1]) * t,
      ]
      best = Math.min(best, haversine(p, q))
    }
  }
  return best
}

// ── The endpoints are the ports ──────────────────────────────────────────────────────
console.log('endpoints survive exactly\n')
{
  const raw = [[120.3, 36], [150, 45], [180, 50], [-160, 48], [-118.2, 33.7]]
  const out = smoothLane(raw)
  check('first point is untouched', out[0], raw[0])
  check('last point is untouched', out[out.length - 1], raw[raw.length - 1])
  check('the input array is not mutated', raw.length, 5)
  check('and the result is longer than the input', out.length > raw.length, true)
}

// ── The antimeridian artifact ────────────────────────────────────────────────────────
//
// searoute writes the crossing TWICE, leaving a zero-length segment whose direction is undefined
// and two kinks either side of it that no ship makes. On the real Qingdao lane those were a 98° and
// a 52° turn, the two largest in open water.
console.log('\nduplicated points\n')
{
  const raw = [[100, 30], [180, 50], [180, 50], [220, 45], [241.9, 33.6]]
  const deduped = dedupe(raw)
  check('a coincident pair collapses to one', deduped.length, 4)
  const out = smoothLane(raw)
  let zero = 0
  for (let i = 0; i < out.length - 1; i += 1) if (haversine(out[i], out[i + 1]) === 0) zero += 1
  check('no zero-length segment survives', zero, 0)
  check('...and the port at the end is still the port', out[out.length - 1], [241.9, 33.6])
}

// ── The unwrap contract ──────────────────────────────────────────────────────────────
//
// The loudest possible failure, and completely silent in the data: a single point wrapped back into
// -180..180 draws a line across the entire map.
console.log('\nlongitudes stay unwrapped\n')
{
  for (const raw of [
    [[120.3, 36], [180, 50], [220, 45], [241.9, 33.6]],   // eastward past +180
    [[-75, 10], [-40, 35], [-14, 40]],                     // ordinary western hemisphere
    [[100, 1], [140, 20], [190, 35], [250, 40], [300, 30]], // far past the meridian
  ]) {
    const out = smoothLane(raw)
    let worst = 0
    for (let i = 0; i < out.length - 1; i += 1) worst = Math.max(worst, Math.abs(out[i + 1][0] - out[i][0]))
    check(`no step jumps a hemisphere (${raw[0][0]} -> ${raw[raw.length - 1][0]})`, worst < 180, true)
  }
}

// ── The bound that keeps it off land ─────────────────────────────────────────────────
console.log('\nhow far the line may move\n')
{
  // A hard mid-ocean dog-leg between two long straights: the case the rounding is FOR.
  const raw = [[140, 40], [180, 40], [200, 20]]
  const out = smoothLane(raw)

  // MEASURED AGAINST THE DENSIFIED PATH, NOT THE RAW ONE, and the distinction is the whole point of
  // separating the two stages. Densifying moves the line off a straight lon/lat segment and onto the
  // great circle — hundreds of km over an ocean crossing — but that is a correction TOWARD the route
  // a ship actually sails, not a liberty taken with it. Only the corner rounding is a liberty, and
  // only it is capped.
  const trueArc = densify(dedupe(raw))   // the same great circle, without any rounding
  let worst = 0
  for (const p of out) worst = Math.max(worst, distanceToPath(p, trueArc))
  check(`rounding never moves the line further than the cap (${MAX_CUT_KM} km)`, worst <= MAX_CUT_KM, true)
  check('...and the corner really was rounded', worst > 10, true)

  // THE HARBOUR CASE. A 138° hairpin on 5-11 km segments is a ship entering a port; cutting it
  // would put the line on land. The cut is a quarter of the shorter segment, so it is ~1.25 km —
  // this is the assertion that the scaling, not a coastline, is what keeps the route off the shore.
  const harbour = [[120.30, 36.00], [120.35, 36.04], [120.28, 36.06]]
  const near = chamfer(harbour)
  let moved = 0
  for (const p of near) moved = Math.max(moved, distanceToPath(p, harbour))
  check('a corner between short segments is barely touched (< 2 km)', moved < 2, true)
}

// ── Long crossings arc ───────────────────────────────────────────────────────────────
//
// A straight lon/lat line is not the path a ship takes. Subdividing along the great circle is more
// faithful than the segment it replaces, and is most of the flow the eye reads.
console.log('\nlong segments follow the great circle\n')
{
  const raw = [[140, 40], [220, 40]]   // ~6,800 km along a parallel
  const out = densify(raw)
  check('a long segment gains intermediate points', out.length > 10, true)
  // A great circle between two points on the same parallel bows POLEWARD of it.
  const maxLat = Math.max(...out.map((p) => p[1]))
  check('...and the arc bows poleward of the parallel', maxLat > 40.5, true)
  check('...without moving the ends', [out[0], out[out.length - 1]], [raw[0], raw[1]])
}

// ── Cheap, stable, and safe on degenerate input ──────────────────────────────────────
console.log('\ncontract\n')
{
  const raw = [[0, 0], [40, 10], [80, 0]]
  check('same input, same output', smoothLane(raw), smoothLane(raw))
  check('memoised to the same array', smoothLane(raw) === smoothLane(raw), true)
  check('two points are left alone', smoothLane([[0, 0], [10, 10]]).length >= 2, true)
  check('one point is returned as-is', smoothLane([[0, 0]]), [[0, 0]])
  check('an empty path does not throw', smoothLane([]), [])
  check('a non-array is returned unchanged', smoothLane(null), null)
}

console.log(failed === 0 ? '\nAll smoothing checks passed.' : `\n${failed} check(s) FAILED.`)
process.exit(failed === 0 ? 0 : 1)
