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

// ── The itinerary: a sailing that calls at more than one port ─────────────────────────
//
// A ship discharges at several places. Two boxes loaded together can come off at New York and at
// Norfolk nine days apart, and that is ONE hull making TWO calls — not two voyages, which is what
// the map drew before holders.js started grouping on the sailing.
//
// A LEG is `{ from, to, coords, start, end }`: the run between two consecutive calls, its polyline,
// and the two dates that bound it. holders.js builds them; these two functions are the only place
// that decides which one a ship is on, and BOTH holders.js and MapView call them. A second copy of
// that decision is exactly how the stats panel and the map came to disagree about `arrived`
// (CLAUDE.md §8) — the tray would then name one leg's dates while the hull sat on another's.

/**
 * Which leg the ship is on today, and how far along it.
 *
 * THE FIRST LEG WHOSE END HAS NOT PASSED. A call date is the day the ship is AT that port, so on
 * the day itself the answer is "leg 1, arrived" rather than "leg 2, just departed" — the two put
 * the marker in the same place, and the first is what the tray should say.
 *
 * ...OR WHOSE CALL NOTHING HAS CONFIRMED. A leg is only left behind once something actually
 * reported the ship at the call that ends it. `end` cannot decide that alone, because on a
 * discharge it falls back to `expected_portdate` (holders.js `callDate`) — a schedule, not an
 * event — so a leg bounded by a guess was being abandoned on the day it was DUE.
 *
 * RUBY TOWER is the case. Its Los Angeles box has no `actual_portdate`; the day after the expected
 * one passed, the ship was drawn 319 km up the California coast on the Los Angeles -> Oakland leg,
 * with nothing saying it ever reached Los Angeles. Held, it sits on the port — which is what
 * `progressByTimeLeft` already does for any leg whose end has passed, so nothing below changes.
 *
 * A FUTURE ACTUAL IS NOT CONFIRMATION. The date has to have arrived.
 *
 * A CONFIRMED CALL RELEASES EVERY HOLD BEFORE IT. If Oakland reports an arrival while Los Angeles
 * is still blank, the ship demonstrably passed Los Angeles and the gap is in the data, not the
 * voyage. Without this the marker would freeze at Los Angeles while the tray showed a box already
 * sitting at Oakland — the map contradicting itself.
 *
 * @returns {{index:number, leg:object, progress:number}|null}
 */
export function activeLegAt(legs, today = new Date()) {
  if (!legs?.length) return null
  const mid = midnight(today)

  // The furthest call proven to have been made. Everything at or before it is confirmed by
  // implication, whatever its own `endActual` says.
  let proven = -1
  for (let i = 0; i < legs.length; i++) {
    if (legs[i].endActual && midnight(legs[i].endActual) <= mid) proven = i
  }

  for (let i = 0; i < legs.length; i++) {
    if ((legs[i].end && mid <= legs[i].end) || i > proven) {
      return { index: i, leg: legs[i], progress: computeProgress(legs[i].start, legs[i].end, today) }
    }
  }
  // Past every call. Reachable while a box is still aboard with no arrival reported — an honest
  // "at the last port we know about" rather than a position off the end of the line.
  const last = legs.length - 1
  return { index: last, leg: legs[last], progress: 1 }
}

/**
 * Total length of a polyline in km.
 *
 * Recomputed rather than read from `sea_routes.distance_km`, because a leg's coords are what the
 * ship is actually drawn along and the stored figure is about the whole stored route. They agree
 * today; a divergence should move the marker with the line, not with the number.
 */
function polylineKm(coords) {
  let total = 0
  for (let i = 0; i < coords.length - 1; i += 1) total += haversine(coords[i], coords[i + 1])
  return total
}

/**
 * Service speed, km/day. 620 is a container ship at roughly 14 knots.
 *
 * NOT DERIVED FROM THIS FEED, deliberately. The 22 live vessels in the 2026-09-03 export imply 223
 * to 689 km/day with a median of 427 — but those are not speeds. Each is a lane divided by a whole
 * ETD -> ETA window, and that window also holds loading, transshipment dwell and waiting for a
 * berth. Dividing by it produces a number no ship has ever steamed at.
 */
const SERVICE_KM_PER_DAY = 620

/**
 * How far along its leg a ship is drawn: OUTWARD FROM THE ORIGIN for the first half of the voyage,
 * INWARD FROM THE DESTINATION for the second.
 *
 * THE SLACK HAS TO GO SOMEWHERE, and that is the whole design. An ETD -> ETA window is not all
 * sailing: it also holds loading, transshipment dwell and waiting for a berth. On these lanes that
 * is most of it — the windows imply 223 to 689 km/day against a real 620 at 14 knots. Every model
 * here is a choice about WHERE to draw the waiting.
 *
 *   Spread evenly    each ship moves at its own implied average, so distance stopped tracking
 *   (the original)   days-to-arrival at all. A ship 10 days out was drawn closer than one 9 days
 *                    out, because its booking was more padded.
 *
 *   All at the start ships arriving together converge correctly, but a vessel 15 days out of Laem
 *   (the first fix)  Chabang still hugs the coast as though it left on Tuesday. ZEPHYR LUMOS sat
 *                    at 0% having sailed on 19 August.
 *
 *   In the middle    departure looks real, arrival stays coherent, and the waiting lands where it
 *   (this one)       actually happens: at a hub, mid-route.
 *
 * FIRST HALF: `elapsed x speed` from the port of loading. The ship leaves at a plausible speed the
 * day it sails, which is what the origin end of the map is read for.
 *
 * SECOND HALF: `remaining x speed` back from the port of discharge. Unchanged from the previous
 * model, so two ships arriving on the same morning are still drawn together whatever their origins.
 *
 * BOTH HALVES ARE CAPPED AT HALF THE LEG, and that cap is what makes the handover continuous rather
 * than a jump. Computed independently the two rules disagree: measured on one lane they were
 * 7,600 km apart at the crossover. Capping both at the midpoint means each saturates there, so at
 * the moment the rule changes both give exactly the same answer. A ship with slack simply holds
 * mid-route until the inbound clock catches up — which is the hub, drawn.
 *
 * THE SPEED IS AT LEAST WHAT THE SCHEDULE DEMANDS. `max(SERVICE_KM_PER_DAY, leg / window)` — a lane
 * needing 689 km/day is being sailed at 689, and without this the cap would not bind on a tight
 * schedule and the handover would jump again. It also keeps an impossible booking honest rather
 * than smoothing it: a leg with today's ETD and a 10-day ETA across 19,091 km needs 1,909 km/day,
 * and this draws it leaving today rather than two thirds of the way across the Pacific.
 */
function progressByTimeLeft(fallback, leg, today) {
  if (!leg?.end || !leg.start || !leg.coords || leg.coords.length < 2) return fallback

  const km = polylineKm(leg.coords)
  if (!km) return fallback

  const daysLeft = Math.round((midnight(leg.end) - midnight(today)) / DAY)
  // Overdue: the ETA has passed with no arrival reported. At the port is the honest place for it.
  if (daysLeft <= 0) return 1

  const daysElapsed = Math.max(0, Math.round((midnight(today) - midnight(leg.start)) / DAY))
  const half = km / 2
  const speed = Math.max(SERVICE_KM_PER_DAY, km / (daysElapsed + daysLeft))

  // `elapsed < left` IS the first half: it rearranges to elapsed < (elapsed + left) / 2.
  const fromEnd =
    daysElapsed < daysLeft
      ? km - Math.min(daysElapsed * speed, half)   // outbound: measured from the origin
      : Math.min(daysLeft * speed, half)           // inbound: measured from the destination

  return Math.min(1, Math.max(0, 1 - fromEnd / km))
}


/**
 * The anchorage. A hull is never drawn ON a port — it stands 150 km off BOTH ends of its leg.
 *
 * A ship at 100% of its polyline is on its discharge port, which is exactly where that port's card
 * is drawn: two markers on one point, and the top one takes every click. It is not a fiction to
 * back it off — a box that is overdue with no `actual_portdate` is a ship that has not been
 * reported alongside, so drawing it at anchor off the port is a better description of what is known
 * than drawing it on the berth.
 *
 * BOTH ENDS, because the collision is symmetric and only the discharge half was ever guarded. A
 * leg's slack is spent at its ORIGIN (§5.1: five of 23 sailings sit there), and a ship at 0% is on
 * its origin card in exactly the way an overdue one is on its discharge card. The floor is the same
 * distance as the cap for the same reason.
 *
 * A FIXED DISTANCE, NOT A FRACTION, and that is the whole design. The rail leg dodges the same
 * collision with `RAIL_START`, 3% along its track, which works because rail lanes are all much of a
 * muchness. Ocean legs are not: measured across the fleet they run 721 km to 20,290 km, a 28-fold
 * spread, so 0.3% is 2 km on the short one and 61 km on the long one — too little to separate
 * anything at one end, too much to be honest at the other. 150 km is 150 km on every lane.
 *
 * 150 KM IS A PIXEL BUDGET, NOT A NAUTICAL ONE, and this is where the previous 25 km failed. At
 * Los Angeles' latitude km-per-pixel is `64.9 / 2^zoom`, and the thing being dodged is a port card
 * of ~27 px collision radius (CARD_BASE_PX 64 x CARD_RADIUS_FACTOR 0.42) plus ~15 px of hull — call
 * it 45 px of clearance wanted:
 *
 *     zoom      km/px      25 km      150 km
 *       3        8.11       3 px       18 px
 *       4        4.06       6 px       37 px
 *       5        2.03      12 px       74 px
 *       7        0.51      49 px      296 px
 *
 * So 25 km only separated anything past about z7, which is not where this map is read. The cost is
 * the other end of that column: at z7+ a hull sits ~300 px offshore and reads as detached from the
 * port it belongs to. That is the price of a fixed distance, and it is the same trade MapView's
 * RAIL_START note already writes down — a geographic offset cannot track a fixed-pixel card at
 * every zoom, and the alternative is nudging in screen space against the cards, which is a
 * different design.
 *
 * A CLAMP, so it only binds where the problem is. Every ship in transit stays exactly where the
 * time model puts it; only the ones that would otherwise sit on a card are moved.
 */
const ANCHORAGE_KM = 150

/**
 * The band of a leg a hull may be drawn in, as `[floor, cap]` fractions.
 *
 * A LEG TOO SHORT TO STAND OFF WITHIN COLLAPSES TO ITS MIDPOINT. Below `2 x ANCHORAGE_KM` the two
 * bounds cross and there is no band left, so the honest answer is the middle — still clear of both
 * cards, and no less true than either end: §5.1 already notes that a leg shorter than a day's
 * steaming has no third answer, and at that length the midpoint IS the standoff.
 */
function anchorageBand(km) {
  if (km <= 2 * ANCHORAGE_KM) return [0.5, 0.5]
  const f = ANCHORAGE_KM / km
  return [f, 1 - f]
}

/**
 * Where the ship is, which way it points, and the track it has left.
 *
 * Reuses computeProgress and positionAtProgress unchanged — one leg at a time is the same problem
 * the single-lane voyage always was, so there is no new geometry here.
 *
 * @returns {{pos:number[], next:number[], index:number, remaining:number[][][]}|null}
 *   `remaining` is one coordinate array PER LEG: the current leg from the ship onward, then each
 *   whole leg after it. Kept as separate lines rather than concatenated so a multi-drop draws as
 *   the several routes it is.
 */
export function positionOnItinerary(legs, today = new Date()) {
  const active = activeLegAt(legs, today)
  if (!active) return null
  const coords = active.leg.coords
  const [floor, cap] = anchorageBand(polylineKm(coords))
  const progress = Math.min(
    Math.max(progressByTimeLeft(active.progress, active.leg, today), floor),
    cap,
  )
  const { pos, cut } = positionAtProgress(coords, progress)
  if (!pos) return null

  // The heading. At the end of a leg the next vertex IS the ship, and computeBearing of a point
  // against itself is 0 — every ship sitting at a port would point due north. Look into the
  // following leg instead, past its first vertex because that vertex is the port it is leaving.
  let next = coords[Math.min(cut + 1, coords.length - 1)]
  if (next[0] === pos[0] && next[1] === pos[1]) {
    const onward = legs[active.index + 1]?.coords
    next = onward?.[1] ?? onward?.[0] ?? next
  }

  return {
    pos,
    next,
    index: active.index,
    remaining: [
      [pos, ...coords.slice(cut + 1)],
      ...legs.slice(active.index + 1).map((l) => l.coords),
    ],
  }
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
// arrive at its inland yard already reading AT YARD 84D.
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

  // ONE WORDING FOR BOTH DWELL STATES. Red said `AGING 83D` and blue `AT YARD 2D`; they now share
  // `AT YARD ${days}D` and only the TONE forks. The label states the fact — how long the box has
  // sat — and leaves the judgement to the number.
  //
  // Note what this costs, because it is the one place in the app that bends the rule in §8 about
  // never resting a distinction on hue alone: the WORD no longer separates red from blue. The
  // NUMBER still does, exactly and by definition — the threshold is three days, so `AT YARD 12D`
  // can only be red and `AT YARD 2D` can only be blue — but that is redundancy a reader has to know
  // the rule to use, where "AGING" simply said the conclusion. The card's 2px tone bar and the
  // Overview's "Red containers" row are the other two channels.
  const label = days === 0 ? 'LANDED TODAY' : `AT YARD ${days}D`
  return { tone: days > 3 ? 'red' : 'blue', label, detail: '' }
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

// ── A LIST OF CONTAINERS IS A WORKLIST, so it is ordered by priority, not by id ────────
//
// Used by the port tray and by search results, which is the point: a container has one place
// in the queue, and it should not depend on which panel you found it through.
//
// FIVE BANDS, in the order they need you:
//
//   0  red      at a yard, past its free time, possibly accruing demurrage
//   1  blue     at a yard, sitting but not yet late
//   2  green    at a yard with an appointment booked — handled, for now
//   3  moving   on a ship or a train, soonest arrival first
//   4  future   not sailed yet; nothing to do but know it exists
//
// Within a yard band, LONGEST DWELL FIRST — the box that has sat longest is both the most
// expensive and the most likely to have been forgotten. Within `moving`, SOONEST ARRIVAL
// first. Within `future`, soonest departure.
//
// THE BAND COMES FROM shipmentState, AND ONLY THEN THE TONE FROM containerStatus. That order
// matters and is easy to get wrong: containerStatus returns tone `blue` for an en-route or
// on-rail container too, so ranking on tone alone files every ship under "blue containers at a
// yard" — invisible in a port tray, where everything is arrived, and wrong the moment a search
// returns a mixed list.
//
// Neither rule is written out here. Both come from the same functions the chip, the map card
// and the Overview counts use — a second copy of "which containers are aging" is exactly how
// the stats panel and the map drifted apart once already (CLAUDE.md §8).
const YARD_RANK = { red: 0, blue: 1, green: 2 }
const BAND_MOVING = 3
const BAND_FUTURE = 4

// One ascending number per container, so the comparator stays a plain subtraction. Dwell is
// NEGATED because it is the one key that runs the other way.
function priorityKey(s, today) {
  const state = shipmentState(s, today)

  if (state === 'arrived') {
    return {
      band: YARD_RANK[containerStatus(s, today).tone] ?? BAND_FUTURE,
      // Dwell at the facility the box is ACTUALLY in. arrivedAtFacility handles the inland
      // case, so a box that cleared its seaport in June counts from the day it reached its
      // yard, not from June (CLAUDE.md §7).
      order: -(daysAtCY(s, today) ?? 0),
    }
  }

  // Not sailed: furthest from needing anything, so it sits below everything in motion however
  // soon it is due.
  if (state === 'future') {
    return { band: BAND_FUTURE, order: parseYMD(s.actual_shipping)?.getTime() ?? Infinity }
  }

  // ON A SHIP OR ON A TRAIN, ranked together on ONE axis: when does this box actually land.
  // A rail leg arriving in two days is more imminent than a ship four weeks out, and keeping
  // them in separate bands would have said otherwise.
  //
  // finalYardEta, not expected_portdate. For a port-delivered container the two are the same
  // date, so this is exactly "whichever vessel arrives first"; for an intermodal one it is the
  // inland CY date, which is when the box is really available. It is also the date the
  // Overview's "Arriving next 7 days" row counts, so the list and the count agree.
  //
  // A missing date sorts to the BOTTOM of the band rather than the top: Infinity, not 0. A
  // blank is not an imminent arrival, and treating it as one would put the least-known
  // containers above everything.
  return { band: BAND_MOVING, order: finalYardEta(s)?.getTime() ?? Infinity }
}

/**
 * @returns {object[]} a NEW array — the caller's is not mutated, because holders are shared
 *   with the map and re-ordering one in place would reach further than the panel that asked.
 */
export function sortByPriority(containers, today = new Date()) {
  // Decorated rather than compared in place: the key functions build label strings and parse
  // dates on every call, and a comparator runs O(n log n) times. Cheap either way at these
  // counts, but it also puts both sort keys somewhere you can read them.
  return (containers ?? [])
    .map((s) => ({ s, ...priorityKey(s, today) }))
    .sort(
      (a, b) =>
        a.band - b.band ||
        a.order - b.order ||
        // Last resort, and it is what keeps the list STABLE: two boxes in the same band with
        // the same date would otherwise be free to swap rows on every refresh.
        (a.s.shipment < b.s.shipment ? -1 : a.s.shipment > b.s.shipment ? 1 : 0),
    )
    .map((d) => d.s)
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
