// Vessel geometry helpers. ALL coordinates are GeoJSON-native [lng, lat]
// (the Leaflet reference used [lat, lng]; the flips are dropped here — see CLAUDE.md §3).

// Collapse whitespace, normalize ", " spacing, trim, lowercase — the shipment↔route join key.
export const normalizeKey = (s) =>
  s ? s.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim().toLowerCase() : ''

// "YYYY-MM-DD" -> local-midnight Date, or null. Manual parse avoids UTC off-by-one.
export function parseYMD(s) {
  if (!s) return null
  const [y, m, d] = s.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d)
}

const R = 6371 // km
const toRad = (x) => (x * Math.PI) / 180

// Great-circle distance in km. a, b = [lng, lat].
export function haversine(a, b) {
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * R * Math.asin(Math.sqrt(h))
}

// Great-circle bearing a->b in degrees 0..360. a, b = [lng, lat].
export function computeBearing(a, b) {
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const dLon = toRad(b[0] - a[0])
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

// Fraction 0..1 of a leg elapsed. start/end = Date, now = Date.
//
// COMPARED AT LOCAL MIDNIGHT, not at the current instant. `start` and `end` come from parseYMD,
// which returns local midnight, so measuring from `new Date()` mixed a timestamp against two
// midnights: a container that landed TODAY was already part-way down its lane, by however far
// through the day it happened to be. Measured on a 13-day rail leg at 19:39, that put the marker
// at 14% instead of 7.7% — roughly 70 km past where the dates say it is.
//
// The inputs are DATES. A day is the finest thing this data actually knows, so interpolating
// inside one is precision it does not have. Progress now steps once a day, which is also the
// cadence the feed itself updates on (CLAUDE.md §6).
export function computeProgress(start, end, now = new Date()) {
  if (!start || !end) return 0
  const s = start.getTime()
  const e = end.getTime()
  if (e <= s) return 1
  return Math.min(Math.max((midnight(now).getTime() - s) / (e - s), 0), 1)
}

// Point at fractional distance `progress` along coords [[lng,lat],...].
// Returns { pos:[lng,lat], cut } where `cut` is the index of the segment start.
export function positionAtProgress(coords, progress) {
  if (!coords || coords.length === 0) return { pos: null, cut: 0 }
  if (coords.length === 1) return { pos: coords[0], cut: 0 }
  let total = 0
  for (let i = 0; i < coords.length - 1; i++) total += haversine(coords[i], coords[i + 1])
  const target = total * progress
  let sum = 0
  for (let i = 0; i < coords.length - 1; i++) {
    const seg = haversine(coords[i], coords[i + 1])
    if (sum + seg >= target) {
      const t = seg === 0 ? 0 : (target - sum) / seg
      const pos = [
        coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
        coords[i][1] + t * (coords[i + 1][1] - coords[i][1]),
      ]
      return { pos, cut: i }
    }
    sum += seg
  }
  return { pos: coords[coords.length - 1], cut: coords.length - 2 }
}

// Golden-angle spiral offset for containers sharing a port (CLAUDE.md §5.4).
// index 0 = exactly on the port; radius compresses past zoom 7. p = [lng, lat].
export function applyContainerOffset([lng, lat], zoom, index = 0) {
  if (index === 0) return [lng, lat]
  const baseOffset = 0.6
  const minZoom = 3
  const maxZoom = 7
  const spiralScale = Math.pow(minZoom / Math.min(zoom, maxZoom), 1.2)
  const compress = zoom > maxZoom ? Math.exp(-(zoom - maxZoom) / 3) : 1
  const j = baseOffset * spiralScale * compress
  const angle = (index * 137.5 * Math.PI) / 180 // golden angle
  return [lng + Math.cos(angle) * j, lat + Math.sin(angle) * j]
}

const DAY = 86400000
const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const isSet = (v) => Boolean(v && v.trim() !== '')

// ── Where a container is, and when it got there ───────────────────────────────────────
//
// THE COMPARISON IS THE WHOLE RULE. port_of_discharge === Lastcy means the box is delivered at the
// port it landed at, and the journey ends there. When they differ the box has an INLAND LEG: it
// moves by rail from the seaport to an interior yard, and the port is a waypoint, not a
// destination.
export const isIntermodal = (s) =>
  normalizeKey(s.port_of_discharge) !== normalizeKey(s.Lastcy) && isSet(s.Lastcy)

// The facility the container is physically at — which is NOT always the discharge port. Once an
// inland leg is complete the box lives at Lastcy, and a card must be drawn there.
export const currentFacility = (s, today = new Date()) =>
  isIntermodal(s) && shipmentState(s, today) === 'arrived' ? s.Lastcy : s.port_of_discharge

// When it reached THAT facility. Dwell has to be measured from arrival at the place it is now,
// not from actual_portdate: an intermodal box that cleared its seaport months ago would otherwise
// arrive at its inland yard already reading AGING 84D.
//
// The inland date is an ESTIMATE — there is no actual_lastcy_date column — so a box appears at the
// yard on expected_lastcy_date whether or not it truly arrived. Same honest-position caveat the
// vessel carries (CLAUDE.md §6).
export const arrivedAtFacility = (s) =>
  isIntermodal(s) ? parseYMD(s.expected_lastcy_date) : parseYMD(s.actual_portdate)

// Whole days a container has been sitting at the yard it is currently in, or null if it has not
// landed there yet.
export function daysAtCY(s, today = new Date()) {
  const arrived = arrivedAtFacility(s)
  return arrived ? Math.floor((midnight(today) - arrived) / DAY) : null
}

// Container color rule for the ARRIVED state (CLAUDE.md §7):
// appointment set -> green; else days-at-CY > 3 -> red; else blue.
export function containerColor(s, today = new Date()) {
  return containerStatus(s, today).tone
}

// The same rule as containerColor, but carrying a WORD as well as a tone, and extended to cover
// every state rather than only `arrived`.
//
// The label is not decoration. On the map, which arm a container sits in encodes its status
// independently of hue (CARDS.md §2) — that redundancy is what makes the card readable to a
// colour-blind reader. A tray is a flat list with no arms, so the word has to do that job there.
// Never render the tone without the label.
//
// `tone` stays one of red / blue / green so the card geometry and the tray share one vocabulary;
// en-route containers are not drawn on a card, so they get a tone only for the chip.
export function containerStatus(s, today = new Date()) {
  const state = shipmentState(s, today)
  if (state === 'future') {
    return { tone: 'blue', label: 'NOT SAILED', detail: `ETD ${s.actual_shipping || '—'}` }
  }
  // The inland leg. Its own word because "ON WATER" would be a lie and "AT YARD" would be worse —
  // the box is between two places and the thing worth knowing is when it lands at the second.
  if (state === 'rail') {
    const end = parseYMD(s.expected_lastcy_date)
    const left = end ? Math.floor((end - midnight(today)) / DAY) : null
    return {
      tone: 'blue',
      label: 'ON RAIL',
      detail:
        left == null
          ? 'no CY date'
          : left >= 0
            ? `${left}d to ${s.Lastcy}`
            : `${-left}d past CY date`,
    }
  }
  if (state === 'enroute') {
    const end = parseYMD(s.expected_portdate)
    const left = end ? Math.floor((end - midnight(today)) / DAY) : null
    return {
      tone: 'blue',
      label: 'ON WATER',
      // Negative means the forwarder's ETA has already passed and no arrival was reported — worth
      // saying out loud rather than rendering as a nonsense countdown.
      detail: left == null ? '—' : left >= 0 ? `${left}d to ETA` : `${-left}d past ETA`,
    }
  }
  // Arrived containers carry NO detail: the chip already states the dwell and the card's own
  // Appointment / Last-free-day rows say the rest. Repeating it beside the date just wrapped the
  // line and said the same thing twice.
  const days = daysAtCY(s, today) ?? 0
  if (isSet(s.appointment_date)) return { tone: 'green', label: 'BOOKED', detail: '' }
  if (days > 3) return { tone: 'red', label: `AGING ${days}D`, detail: '' }
  return { tone: 'blue', label: days === 0 ? 'LANDED TODAY' : `AT YARD ${days}D`, detail: '' }
}

// Where a container is in its journey (CLAUDE.md §7). Today defaults to now's local midnight.
//
//   future    not sailed yet
//   enroute   on a vessel, along the SEA lane
//   rail      on a train, along the RAIL lane — only ever for an intermodal shipment
//   arrived   sitting at a facility: the discharge port, or the inland yard if it went on
//
// `rail` sits BETWEEN enroute and arrived. A box that has cleared its port but not yet reached its
// inland yard is not "arrived" in any useful sense — drawing it as a container at the seaport was
// wrong from the moment it rolled out, which is what this state exists to fix.
export function shipmentState(s, today = new Date()) {
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const start = parseYMD(s.actual_shipping)
  const arrived = parseYMD(s.actual_portdate)
  if (start && start > todayMid) return 'future'
  if (arrived && arrived <= todayMid) {
    if (isIntermodal(s)) {
      // No expected_lastcy_date means we know it left the port but not when it lands. Treat that
      // as still moving rather than silently placing it at a yard it may not have reached.
      const lastcy = parseYMD(s.expected_lastcy_date)
      if (!lastcy || lastcy > todayMid) return 'rail'
    }
    return 'arrived'
  }
  return 'enroute'
}
