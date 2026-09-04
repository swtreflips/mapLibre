// Turn a routed path into one worth drawing.
//
// `sea_routes` holds searoute's output: a path through a maritime graph, drawn as straight lon/lat
// segments between its nodes. It is the correct route and an angular picture, and measuring one
// says why — three separate faults, only the last of which is about smoothing:
//
//   Qingdao -> Los Angeles, 71 points        turn   segIn   segOut   at
//     the antimeridian, twice                 98°   423km      0km   [180.0, 50.0]
//                                             52°     0km     46km   [180.0, 50.0]
//     the harbour approach                   138°     6km     68km   [120.3, 36.0]
//                                            129°     5km     11km   [241.9, 33.6]
//     open water        42 corners, mean 7.8°, punctuated by 42-63° dog-legs
//                       between 200-600 km straights
//
// The antimeridian pair is a PURE ARTIFACT — searoute emits the crossing as a duplicated point, so
// every trans-Pacific route carries a zero-length segment between two fake kinks. The harbour turns
// are REAL: a 138° hairpin on 5 km segments is a ship entering a port, and rounding it would put
// the line on land. The open-water dog-legs are the ugliness.
//
// SO THE CUT IS SCALED TO THE GEOMETRY RATHER THAN GATED ON A LAND MASK. Near land the segments are
// short, so the cut is small; in open ocean they are long, so it is not. The geometry already
// encodes the difference, which is why this needs no coastline data to stay off the coast.
//
// Pure: coordinates in, coordinates out. No map, no projection.

const R = 6371 // km
const toRad = (x) => (x * Math.PI) / 180
const toDeg = (x) => (x * 180) / Math.PI

/** Great-circle distance in km. a, b = [lng, lat]. */
function haversine(a, b) {
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(toRad(a[1])) * Math.cos(toRad(b[1]))
  return 2 * R * Math.asin(Math.sqrt(h))
}

/**
 * Keep a longitude on the same turn of the world as the one before it.
 *
 * THESE COORDS ARE DELIBERATELY UNWRAPPED. A Pacific route runs past +180 — Qingdao -> Los Angeles
 * reaches 241.9 — so the line draws east across the ocean instead of jumping back across Eurasia.
 * Every trigonometric step here returns a longitude in -180..180, which would silently break that
 * and streak the route across the whole map. Shifting by whole turns until it is within 180° of its
 * predecessor restores the continuation.
 */
function continueFrom(prevLng, lng) {
  let out = lng
  while (out - prevLng > 180) out -= 360
  while (out - prevLng < -180) out += 360
  return out
}

/** A point fraction `t` along the great circle from a to b, continued from a's turn of the world. */
function slerp(a, b, t) {
  const φ1 = toRad(a[1])
  const λ1 = toRad(a[0])
  const φ2 = toRad(b[1])
  const λ2 = toRad(b[0])

  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2,
  ))
  // Coincident, or as near as makes no difference: the interpolation is undefined and unnecessary.
  if (!d || !Number.isFinite(d)) return [a[0], a[1]]

  const A = Math.sin((1 - t) * d) / Math.sin(d)
  const B = Math.sin(t * d) / Math.sin(d)
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2)
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2)
  const z = A * Math.sin(φ1) + B * Math.sin(φ2)

  const lat = toDeg(Math.atan2(z, Math.hypot(x, y)))
  const lng = toDeg(Math.atan2(y, x))
  return [continueFrom(a[0], lng), lat]
}

/** Point `km` along the great circle from a toward b. */
function along(a, b, km) {
  const total = haversine(a, b)
  return total ? slerp(a, b, Math.min(1, km / total)) : [a[0], a[1]]
}

// ── the four stages ──────────────────────────────────────────────────────────────────

/** Consecutive points closer than this are one point. */
const DEDUPE_KM = 0.5

/** Segments longer than this are subdivided along the great circle. */
const DENSIFY_KM = 150

/** A corner is never cut by more than this, however long its segments. */
const MAX_CUT_KM = 80

/** ...and never by more than this fraction of the shorter one, which is what keeps it off land. */
const CUT_FRACTION = 0.25

/**
 * Drop coincident points.
 *
 * This alone removes the two largest fake turns on every trans-Pacific route: searoute writes the
 * antimeridian crossing twice, leaving a zero-length segment whose direction is undefined, and two
 * kinks either side of it that no ship makes.
 */
function dedupe(coords) {
  const out = [coords[0]]
  for (let i = 1; i < coords.length; i += 1) {
    if (haversine(out[out.length - 1], coords[i]) >= DEDUPE_KM) out.push(coords[i])
  }
  // The last point is the PORT and must be exact. If it was dropped as a near-duplicate, put it
  // back in place of what swallowed it rather than ending the line short of its destination.
  const last = coords[coords.length - 1]
  if (out[out.length - 1] !== last) out[out.length - 1] = last
  return out
}

/**
 * Subdivide long segments along the great circle.
 *
 * A 1,316 km leg currently draws as one straight lon/lat line, and a straight line in lon/lat is not
 * the path a ship takes — the real great circle bulges away from it. Subdividing makes long
 * crossings arc, which is MORE faithful than what was there, and is most of the flow the eye reads.
 */
function densify(coords) {
  const out = [coords[0]]
  for (let i = 1; i < coords.length; i += 1) {
    const a = coords[i - 1]
    const b = coords[i]
    const d = haversine(a, b)
    const steps = Math.ceil(d / DENSIFY_KM)
    for (let s = 1; s < steps; s += 1) out.push(slerp(a, b, s / steps))
    out.push(b)
  }
  return out
}

/**
 * Replace each interior corner with a chamfer, cut by
 * `min(CUT_FRACTION x shorter adjacent segment, MAX_CUT_KM)`.
 *
 * THE FORMULA IS THE SAFETY ARGUMENT. The harbour hairpin sits between a 5 km and an 11 km segment,
 * so it is cut by 1.25 km and survives essentially untouched; a mid-Pacific corner between two
 * 400 km straights is cut by the full 80. Nothing here knows where the land is, and it does not need
 * to — a corner tight enough to matter is a corner whose segments are short.
 */
function chamfer(coords) {
  if (coords.length < 3) return coords
  const out = [coords[0]]
  for (let i = 1; i < coords.length - 1; i += 1) {
    const prev = coords[i - 1]
    const here = coords[i]
    const next = coords[i + 1]
    const cut = Math.min(CUT_FRACTION * Math.min(haversine(prev, here), haversine(here, next)), MAX_CUT_KM)
    if (cut <= 0) { out.push(here); continue }
    out.push(along(here, prev, cut))
    out.push(along(here, next, cut))
  }
  out.push(coords[coords.length - 1])
  return out
}

/**
 * One Chaikin pass: replace each interior point with points a quarter and three quarters along its
 * neighbouring segments, keeping the ends.
 *
 * Run over the CHAMFERED line, so the segments it cuts are the short ones the chamfer just created
 * around each old corner. That is what bounds the result: the curve stays inside the chamfer, so no
 * point ends up further than MAX_CUT_KM from the path searoute actually routed.
 */
function chaikin(coords) {
  if (coords.length < 3) return coords
  const out = [coords[0]]
  for (let i = 0; i < coords.length - 1; i += 1) {
    const a = coords[i]
    const b = coords[i + 1]
    out.push(slerp(a, b, 0.25))
    out.push(slerp(a, b, 0.75))
  }
  out.push(coords[coords.length - 1])
  return out
}

// Keyed on the raw coords ARRAY, not a lane string: `routesByKey` is fetched once and stable, so the
// same array arrives on every rebuild and hits this. Weak, so a route that stops being referenced is
// collected rather than pinned for the life of the tab.
const cache = new WeakMap()

/**
 * The drawn line, and the line the ship rides.
 *
 * ONE ARRAY FOR BOTH. `positionOnItinerary` walks `leg.coords` and `remaining` is sliced from it, so
 * smoothing for display alone would leave the hull beside its own track. Called at leg construction
 * (holders.js) precisely so there is only ever one geometry.
 */
export function smoothLane(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return coords
  const hit = cache.get(coords)
  if (hit) return hit

  // ORDER MATTERS, and getting it wrong is silent. CHAMFER BEFORE DENSIFY: the cut is a quarter of
  // the shorter adjacent segment, and that is only a meaningful measure while the segments are the
  // ones searoute routed. Densifying first caps every segment at 150 km, so an ocean dog-leg between
  // two 400 km straights would be cut by 37 km instead of 80 — and, worse, the short-segments-mean-
  // land heuristic loses most of its contrast, which is the only thing keeping the line off a coast.
  const out = chaikin(chaikin(densify(chamfer(dedupe(coords)))))
  cache.set(coords, out)
  return out
}

export const __test = { dedupe, densify, chamfer, chaikin, haversine, slerp, MAX_CUT_KM }
