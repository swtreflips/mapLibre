// Vessel geometry helpers. ALL coordinates are GeoJSON-native [lng, lat]
// (the Leaflet reference used [lat, lng]; the flips are dropped here — see CLAUDE.md §3).

// Collapse whitespace, normalize ", " spacing, trim, lowercase — the shipment↔route join key.
export const normalizeKey = (s) =>
  s ? s.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim().toLowerCase() : ''

// ── Port complexes ───────────────────────────────────────────────────────────────────
//
// Some neighbouring ports work as ONE gateway. Los Angeles and Long Beach share a harbour and are
// routinely quoted together; Miami and Port Everglades are handled as a pair. Two consequences,
// and the second is the one that is easy to miss:
//
//   1. They draw ONE card, named for the canonical port (holders.js).
//   2. A move BETWEEN them is not a rail leg. A box discharged at Los Angeles and delivered to a
//      Long Beach yard has gone across a harbour, not across the country — see isIntermodal.
//
// Lives here rather than in data/places.js, where the rest of the port config sits, only because
// isIntermodal needs it and places.js already imports normalizeKey from this file; the reverse
// edge would be an import cycle.
//
// Keys are normalizeKey form. The VALUE must be a real `us_ports` row, or the merged card has
// nothing to anchor to.
export const PORT_ALIASES = new Map([
  ['long beach, ca', 'Los Angeles, CA'],
  ['port everglades, fl', 'Miami, FL'],
])

/** The name a port should be GROUPED and LABELLED under. Identity for everything unaliased. */
export const canonicalPort = (name) => PORT_ALIASES.get(normalizeKey(name)) ?? name

/** The grouping key for a facility, with any complex already resolved. */
export const facilityKey = (name) => normalizeKey(canonicalPort(name))

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
//
// Compared on CANONICAL keys, though, so a move INSIDE one port complex is not a rail leg. A box
// discharged at Los Angeles and delivered to a Long Beach yard has crossed a harbour — 4.6 km —
// and the plain name comparison called that intermodal, which would have drawn a railcar creeping
// between them over a fortnight. Those boxes stay ordinary arrivals: `actual_portdate` decides when
// they land, and they land on the complex's single card.
export const isIntermodal = (s) =>
  facilityKey(s.port_of_discharge) !== facilityKey(s.Lastcy) && isSet(s.Lastcy)

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

// The date a box reaches its LAST CY — the end of its whole journey, not the end of a leg.
//
// It is not one column. For a container delivered at the port it landed at, the port date IS the CY
// date; only an intermodal one has a separate inland date. Reusing isIntermodal means the port
// complex exception comes free: an LA -> Long Beach transfer is not intermodal, so it correctly
// uses the port date rather than a Long Beach lastcy date.
export const finalYardEta = (s) =>
  isIntermodal(s) ? parseYMD(s.expected_lastcy_date) : parseYMD(s.expected_portdate)

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

// ── The voyage line ───────────────────────────────────────────────────────────────────
//
// How soon a holder arrives, or how long ago it left. This is the question the tray header exists
// to answer, and the one nobody should have to do arithmetic against today's date for — every time
// they look.
//
// Takes the two DATES rather than a holder, so vessels and trains share it unchanged. Both are the
// same problem — a thing travelling between two dates — and neither caller has to know which
// columns fed them (a vessel's are actual_shipping -> expected_portdate, a train's are
// actual_portdate -> expected_lastcy_date).
//
// THE FRACTION IS computeProgress, the SAME call MapView makes to position the icon. That is
// deliberate reuse, not a coincidence: a second copy of the rule is exactly how the stats panel and
// the map came to disagree about `arrived` (CLAUDE.md §8). One number, or the sentence and the ship
// end up in different places on the same ocean.
//
// OVERDUE IS TESTED BEFORE THE FRACTION, and that ordering is the whole subtlety of this function.
// computeProgress CLAMPS to 1, so once the ETA passes the fraction stops moving and can no longer
// tell "lands today" from "three weeks late". Only the raw day delta knows, so it decides first.
// Without that, the panel renders "ARRIVING IN -1 DAYS" the day after any ETA slips — and an ETA
// slipping silently is the exception this dashboard exists to surface.
const plural = (n) => (n === 1 ? 'DAY' : 'DAYS')

// Zero gets its own wording. "ARRIVING IN 0 DAYS" is not something a person says, and it is live in
// the fixture rather than hypothetical.
function phraseFor(phase, days) {
  if (phase === 'overdue') return `${days} ${plural(days)} PAST ETA`
  if (phase === 'arriving') return days === 0 ? 'ARRIVING TODAY' : `ARRIVING IN ${days} ${plural(days)}`
  return days === 0 ? 'DEPARTED TODAY' : `DEPARTED ${days} ${plural(days)} AGO`
}

/**
 * @returns {{phase: 'departed'|'arriving'|'overdue', days: number, label: string,
 *   progress: number} | null} null when either date is missing — computeProgress returns 0 for a
 *   null input, which would otherwise render a confident "DEPARTED NaN DAYS AGO". A port holder
 *   has no voyage at all, so it takes this path every time.
 */
export function voyagePhase(etd, eta, today = new Date()) {
  if (!etd || !eta) return null
  const mid = midnight(today)
  const daysTo = Math.floor((eta - mid) / DAY)
  const daysSince = Math.floor((mid - etd) / DAY)
  const progress = computeProgress(etd, eta, today)

  // Exactly half counts as arriving, so the boundary is decided rather than left to a float.
  const phase = daysTo < 0 ? 'overdue' : progress >= 0.5 ? 'arriving' : 'departed'
  const days = phase === 'overdue' ? -daysTo : phase === 'arriving' ? daysTo : daysSince
  return { phase, days, progress, label: phraseFor(phase, days) }
}

// "30 Sep", or "30 Sep 2027" when the year is not the current one.
//
// THE YEAR IS NOT DECORATION. Transits in this data run to 114 days, so a cross-year ETA is
// ordinary — and a bare "15 Jan" read on 30 Aug 2026 reads as LAST January, so the date would say
// the opposite of what it means.
//
// SPELLED OUT RATHER THAN LOCALE-FORMATTED, and that is not reinventing a wheel. toLocaleDateString
// with a pinned 'en-GB' was tried first, for deterministic day-month order; en-GB renders September
// as "Sept" — four letters where every other month gets three, so the column jitters. Locale data
// is not a fixed target either: Node's ICU build and the browser's need not agree, and a difference
// would show up as the app rendering something the test never saw. Twelve strings cannot surprise
// anyone.
//
// Reads the LOCAL components of a local-midnight parseYMD date, so it cannot shift the day the way
// toISOString would (CLAUDE.md §4).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function formatDay(d, today = new Date()) {
  if (!d) return ''
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return d.getFullYear() === today.getFullYear() ? base : `${base} ${d.getFullYear()}`
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
