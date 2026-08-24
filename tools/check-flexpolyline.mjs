// Regression test for the HERE flexible-polyline decoder.
//
//   npm run test:flexpolyline
//
// WHY THIS EXISTS. The decoder shipped with '-' and '_' swapped in its charset ('-' is 62,
// '_' is 63). That is not a loud failure: one misread '-' adds a single bit to a varint, which
// at shift 15 is 32768, which after zigzag is 16384 microdegrees — so every point lands with a
// constant 0.016384 degree offset. On screen the route still looks like a route; it just runs
// ~1.5 km beside the actual highway, and the accumulated per-point error inflates its length by
// ~40%, which then coincidentally resembled the stored distance_m closely enough to look verified.
//
// HERE's own published test vectors did NOT catch it, because they contain neither '-' nor '_'.
// Vector 3 below is a real polyline from drayage_routes that contains both. Keep it.

import { decodeFlexPolyline } from '../src/lib/flexPolyline.js'

const VECTORS = [
  {
    name: "HERE official — 2D, precision 5 (note: contains no '-' or '_')",
    encoded: 'BFoz5xJ67i1B1B7PzIhaxL7Y',
    expected: [
      [8.69821, 50.10228],
      [8.69567, 50.10201],
      [8.6915, 50.10063],
      [8.68752, 50.09878],
    ],
  },
  {
    name: 'HERE official — 3rd dimension present; Z must be consumed to stay aligned',
    encoded: 'BlBoz5xJ67i1BU1B7PUzIhaUxL7YU',
    expected: [
      [8.69821, 50.10228],
      [8.69567, 50.10201],
      [8.6915, 50.10063],
      [8.68752, 50.09878],
    ],
  },
  {
    name: "real drayage_routes polyline containing BOTH '-' and '_' — the charset regression",
    encoded: 'BGu_j-qCh_-jyEAA',
    expected: [
      [-76.611057, 39.290871],
      [-76.611057, 39.290871],
    ],
  },
]

const TOL = 1e-6
let failures = 0

for (const { name, encoded, expected } of VECTORS) {
  let got
  try {
    got = decodeFlexPolyline(encoded)
  } catch (err) {
    console.error(`FAIL  ${name}\n        threw: ${err.message}`)
    failures += 1
    continue
  }

  if (got.length !== expected.length) {
    console.error(`FAIL  ${name}\n        got ${got.length} points, expected ${expected.length}`)
    failures += 1
    continue
  }

  const bad = expected.findIndex(
    ([lng, lat], i) => Math.abs(got[i][0] - lng) > TOL || Math.abs(got[i][1] - lat) > TOL,
  )
  if (bad >= 0) {
    console.error(
      `FAIL  ${name}\n        point ${bad}: got [${got[bad]}], expected [${expected[bad]}]`,
    )
    failures += 1
  } else {
    console.log(`ok    ${name}`)
  }
}

if (failures > 0) {
  console.error(`\n${failures} of ${VECTORS.length} vectors failed`)
  process.exit(1)
}
console.log(`\nall ${VECTORS.length} vectors passed`)
