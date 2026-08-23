// The ONLY text that appears on the map.
//
// The basemap (src/map/basemapStyle.js) ships zero labels on purpose — no countries, no cities,
// nothing from a vendor's idea of what matters. Every name you see comes from here, so this is
// where the map's information design lives.
//
// EVERY place is database-driven — nothing here is hand-typed any more:
//
//   US ports and inland facilities  -> Supabase `us_ports` (src/hooks/useUsPorts.js), filtered to
//     type P (seaport) and I (inland facility), at their own surveyed coordinates.
//
//   International load ports        -> the CURATED list below (src/hooks/useLoadingPorts.js),
//     with coordinates always read live from `world_ports`.
//
// The two sides behave differently ON PURPOSE:
//
//   US      grows by itself. Whatever operations add to `us_ports` shows up on the map with no
//           code change — minus the explicit exclusions below.
//   Intl    does not. The list is fixed, so an unfamiliar port appearing in the schedules feed
//           never quietly rewrites the map. Adding one is a deliberate edit here.
//
// Coordinates are GeoJSON-native [lng, lat] (CLAUDE.md §3).

import { normalizeKey } from '../lib/vesselMath'

// kind — drives colour and weight:
//   'us_port'   US seaport            accent ring, dark bold label
//   'rail_yard' inland yard / CY      accent ring, dark bold label
//   'intl_port' overseas port         grey ring, grey regular label
//
// minzoom — the zoom at which a place appears at all (dot AND name), the way Google Maps stages
//   city labels by importance. At the fully-zoomed-out world view NOTHING is labelled. Use WHOLE
//   numbers: MapLibre re-evaluates zoom-dependent filters only at integer zoom levels.
//
//   It is a floor, not a guarantee. Where two places are too close to both fit, collision drops
//   one — and `symbol-sort-key` is this same minzoom, so the more important place keeps its name
//   and the lesser one shows as a bare dot until you zoom further.

// Staging for database-driven US places, expressed as the two knobs that actually matter:
//
//   PORT_BAND_START  the zoom seaports appear at — move this to bring EVERYTHING in earlier
//                    or later together.
//   PORT_BAND_GAP    how many zooms later inland facilities follow.
//
// The GAP is the effect worth preserving: seaports establish the coastline network first, then
// the inland network fills in behind it. Shifting the start without touching the gap moves both
// groups together and keeps that reveal intact — which is why they are separate constants rather
// than two hardcoded numbers that have to be kept in sync by hand.
const PORT_BAND_START = 3
const PORT_BAND_GAP = 1

export const MINZOOM_BY_PORT_TYPE = {
  P: PORT_BAND_START,
  I: PORT_BAND_START + PORT_BAND_GAP,
}
const KIND_BY_PORT_TYPE = { P: 'us_port', I: 'rail_yard' }
// `us_ports.size` splits each band in turn, so the big gateways land a zoom before the rest of
// their own group. Note every 'I' row is currently size L, so inland facilities arrive as one
// block — the split only actually bites on seaports today.
const minzoomFor = (type) => MINZOOM_BY_PORT_TYPE[type] ?? MINZOOM_BY_PORT_TYPE.I
const placeMinzoom = (row) => minzoomFor(row.type) + (row.size === 'L' ? 0 : 1)

// International load ports are the far end of every lane, so they earn an early slot; `size` from
// world_ports splits the band the same way it does for US ports.
const INTL_MINZOOM = 3

// ── The curated international list ───────────────────────────────────────────────────
//
// These are `world_ports.canonical_name` values, and they must match EXACTLY — the lookup is an
// `in` filter, so a near-miss string silently yields no port rather than an error. Derived once
// from the distinct `schedules.port_of_loading` values; re-derive with the `map_loading_ports`
// view (CLAUDE.md §15) when the network changes, then paste the result here.
//
// Coordinates deliberately are NOT stored here — they come from world_ports at runtime, so a
// corrected coordinate takes effect without a redeploy.
export const INTL_PORTS = [
  'Cartagena, Colombia',
  'Hai Phong, Vietnam',
  'Ho Chi Minh, Vietnam',
  'Jebel Ali, United Arab Emirates',
  'Karachi, Pakistan',
  'Laem Chabang, Thailand',
  'Manila, Philippines',
  'Mundra, India',
  'Nhava Sheva, India',
  'Pipavav, India',
  'Puerto Quetzal, Guatemala',
  'Qingdao, China',
  'Semarang, Indonesia',
]

// ── US exclusions ────────────────────────────────────────────────────────────────────
//
// `us_ports` is read live so the map grows with operations, but a few rows are not places we want
// on it. Matched case-insensitively against `canonical_name`; every entry below was verified to
// exist in the table, since an unmatched string here would silently exclude nothing.
export const US_PORT_EXCLUSIONS = new Set(
  [
    'Wilmington, DE',
    'Southwest Pass, LA',
    'Good Hope, LA',
    'Port Angeles, WA',
    'Gloucester, NJ',
    'San Diego, CA',
  ].map((s) => s.toLowerCase()),
)

export const isExcludedUsPort = (row) =>
  US_PORT_EXCLUSIONS.has((row.canonical_name || '').trim().toLowerCase())

const feature = ({ id, name, kind, minzoom, coordinates, portKey }) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates },
  properties: { id, name, kind, minzoom, portKey },
})

// A us_ports row -> map feature, plotted at the table's own surveyed lat/lng.
//
// `canonical_name` is the label AND the join key, for the same reason: it is the only clean form
// in the table. `name` is inconsistently cased row to row ("LONG BEACH" next to "Cincinnati"), and
// canonical_name already carries the state ("Long Beach, CA"), which is exactly how shipment data
// spells ports — so normalizeKey(canonical_name) joins straight to port_of_discharge with nothing
// to assemble. Fall back down the chain only if it is null.
export function usPortFeature(row) {
  const name = row.canonical_name || row.name || row.unlocode || row.id
  return feature({
    id: `us:${row.id}`,
    name,
    kind: KIND_BY_PORT_TYPE[row.type] ?? 'us_port',
    minzoom: placeMinzoom(row),
    coordinates: [row.longitude, row.latitude],
    portKey: normalizeKey(name),
  })
}

// A world_ports row -> map feature. `canonical_name` is both label and join key for the same
// reason it is on the US side: it is the clean, unique form, and it is what shipment data
// spells ports as.
export function intlPortFeature(row) {
  const name = row.canonical_name || row.unlocode
  return feature({
    id: `intl:${row.canonical_name}`,
    name,
    kind: 'intl_port',
    minzoom: INTL_MINZOOM + (row.size === 'L' ? 0 : 1),
    coordinates: [row.longitude, row.latitude],
    portKey: normalizeKey(name),
  })
}

// Merge both database sources into the one FeatureCollection the `places` source consumes.
// Either side may still be null while its fetch is in flight; the map just shows fewer places.
export function buildPlacesFC({ usPorts, intlPorts } = {}) {
  return {
    type: 'FeatureCollection',
    features: [
      ...(intlPorts ?? []).map(intlPortFeature),
      ...(usPorts ?? []).filter((r) => !isExcludedUsPort(r)).map(usPortFeature),
    ],
  }
}

// Empty first paint — every place now arrives from Supabase.
export const placesFC = buildPlacesFC()
