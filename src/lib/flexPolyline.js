// HERE Flexible Polyline decoder.
//
// `drayage_routes.polyline` comes from HERE (the table's `provider` column defaults to 'here',
// and the table is documented as a "HERE truck-route cache"). HERE does NOT use Google's encoded
// polyline algorithm — this is a different format with its own charset, a header carrying the
// coordinate precision, and optional 3rd-dimension values.
//
// The failure mode matters: feeding a flexible polyline to a Google polyline decoder does not
// throw, it silently yields coordinates in the wrong place. So decode with the right one.
//
// Format: a varint header (version, then precision / 3rd-dim type / 3rd-dim precision), followed
// by zigzag-encoded varint deltas — lat, lng, and a 3rd value when the header declares one.
// Spec: https://github.com/heremaps/flexible-polyline

// HERE's charset, verbatim from @here/flexpolyline. The last two characters are '-' then '_',
// so '-' is 62 and '_' is 63 — DO NOT swap them.
//
// Getting that pair backwards is not a loud failure. A single '-' misread as 63 instead of 62
// puts one extra bit into a varint; if it lands at shift 15 that is 32768, which after zigzag is
// 16384 µdeg — a constant 0.016384 degree offset applied to every subsequent point. The route
// still looks like a route, it just sits ~1.5 km beside the actual road. This file shipped with
// exactly that bug, and HERE's own published test vector did NOT catch it, because that vector
// happens to contain neither '-' nor '_'. The regression test alongside this file uses a real
// polyline that does.
const ENCODING_TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

const DECODING_TABLE = (() => {
  const table = new Int8Array(128).fill(-1)
  for (let i = 0; i < ENCODING_TABLE.length; i += 1) table[ENCODING_TABLE.charCodeAt(i)] = i
  return table
})()

// Deltas can exceed 32 bits once shifted, and JS bitwise operators silently truncate to 32 —
// so accumulate with multiplication rather than `<<`.
function decodeUnsigned(encoded, start) {
  let result = 0
  let shift = 0
  let i = start
  while (i < encoded.length) {
    const code = encoded.charCodeAt(i++)
    const value = code < 128 ? DECODING_TABLE[code] : -1
    if (value < 0) throw new Error(`flexPolyline: illegal character at index ${i - 1}`)
    result += (value & 0x1f) * 2 ** shift
    if ((value & 0x20) === 0) return [result, i]
    shift += 5
  }
  throw new Error('flexPolyline: truncated input')
}

// Zigzag: even -> positive, odd -> negative. Written arithmetically for the same 32-bit reason.
const toSigned = (v) => (v % 2 === 1 ? -(v + 1) / 2 : v / 2)

// Returns GeoJSON-native [lng, lat] pairs (CLAUDE.md §3), ready for a LineString.
export function decodeFlexPolyline(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) return []

  let idx = 0
  let version
  ;[version, idx] = decodeUnsigned(encoded, idx)
  if (version !== 1) throw new Error(`flexPolyline: unsupported version ${version}`)

  let header
  ;[header, idx] = decodeUnsigned(encoded, idx)
  const precision = header & 15
  const thirdDim = (header >> 4) & 7

  const factor = 10 ** precision

  const coordinates = []
  let lat = 0
  let lng = 0
  let v

  while (idx < encoded.length) {
    ;[v, idx] = decodeUnsigned(encoded, idx)
    lat += toSigned(v)
    ;[v, idx] = decodeUnsigned(encoded, idx)
    lng += toSigned(v)
    // A 3rd dimension (elevation etc.) still has to be CONSUMED even though the map ignores it —
    // skipping the read would desynchronise every subsequent lat/lng in the stream.
    if (thirdDim) [, idx] = decodeUnsigned(encoded, idx)
    coordinates.push([lng / factor, lat / factor])
  }

  // Cheap sanity check. A wrong-format decode produces plausible-looking numbers rather than an
  // error, so catch the obvious case before it lands on the map as a line through the Atlantic.
  const bad = coordinates.find(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(y) > 90 || Math.abs(x) > 180)
  if (bad) throw new Error(`flexPolyline: decoded out-of-range coordinate ${JSON.stringify(bad)}`)

  return coordinates
}
