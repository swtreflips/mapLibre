// HOLDERS — the things on the map that hold containers.
//
// The map was first built thinking in containers: one icon per container, one selection per
// shipment. The working model is the other way round. A container is always somewhere, and that
// somewhere is a VESSEL carrying it, a TRAIN carrying it, or a FACILITY it is sitting at. All
// three hold 1..N. Clicking any of them fills the tray with what it holds.
//
// This module owns the grouping and nothing else — no map, no projection, no React. It answers
// "what is where", and MapView decides how to draw it.

import {
  activeLegAt,
  normalizeKey,
  parseYMD,
  shipmentState,
  currentFacility,
  canonicalPort,
  facilityKey,
} from './vesselMath'
import { smoothLane } from './smoothRoute'

// The sea lane. Two spellings are live: `route` on shipments that end at their discharge port, and
// `sea_route` on intermodal ones that also carry a `rail_route`. Neither column exists in the
// production schema yet (CLAUDE.md §14), so both have to work — and reading only `route` would
// silently drop an intermodal shipment that is still at sea, because the lane lookup would miss
// and the loop would skip it.
const seaLane = (s) => s.sea_route ?? s.route

// Sorted by shipment id so a container keeps its slot in a card stack and its row in the tray
// across refreshes, rather than shuffling when the data reloads.
const byShipment = (a, b) => (a.shipment < b.shipment ? -1 : a.shipment > b.shipment ? 1 : 0)

const DAY = 86400000

// TWO LOADS ON ONE SAILING ARE AT MOST THIS FAR APART. Beyond it, the same ship is on its next
// voyage. See assignSailings.
const LOAD_WINDOW_DAYS = 21

// THE SAILING a container is aboard: one hull, one voyage, and however many ports it calls at —
// AT BOTH ENDS. It loads at Nhava Sheva and again at Pipavav a week later, then discharges at Los
// Angeles; or it loads at Cartagena and discharges at New York and then Norfolk.
//
// THE KEY CANNOT BE READ OFF A ROW, and that is what makes this a pass rather than a function.
// It was `vessel + POL + ETD`, which handled multi-DISCHARGE fine — the boxes shared a departure.
// Multi-LOAD breaks it outright: the Nhava Sheva box and the Pipavav box have a different port of
// loading AND a different ETD, so no key built from one row could ever put them on one hull.
//
// AND THE FEED HAS NO VOYAGE NUMBER. Nothing in a shipment says which voyage it is; `mbl` is a
// booking, not a hull. So the only thing separating "two load calls on one sailing" from "two
// sailings of one ship" is HOW FAR APART THE LOAD DATES ARE, and the threshold is a judgement
// about the trade rather than a fact in the data. WAN HAI 272 is the case that matters: two real
// Bangkok sailings 99 days apart, which must not merge.
//
// Gaps are measured against the PREVIOUS load, not the first — a ship working three ports over
// eighteen days is one voyage, and anchoring on the first load would cut it in half. The cost is
// that a long enough chain of small gaps merges; at 21 days that needs a ship loading fortnightly
// for months, which no round trip does.
//
// Three ways out into a holder of one, all of them the rule being honest rather than exceptions
// to it. A blank VESSEL NAME cannot be shared — every unnamed row would otherwise collapse into a
// single ghost ship on whatever else they happened to have in common. A MISSING ETD cannot be
// clustered against anything: two unknowns are not the same unknown. And a MISSING PORT OF LOADING
// leaves the start of the itinerary unstated.
//
// NORMALIZED, because port and vessel names in this data are not: `Singapore`, `SINGAPORE` and
// `Singapore, Singapore` are all legal spellings of one place (CLAUDE.md §4).
//
/** @returns {Map<string,string>} shipment id -> sailing key */
function assignSailings(shipments) {
  const byVessel = new Map()
  const keys = new Map()

  for (const s of shipments) {
    const vessel = normalizeKey(s.vessel)
    const etd = parseYMD(s.actual_shipping)
    const pol = s.port_of_loading
    if (!vessel || !etd || !pol || !String(pol).trim()) {
      keys.set(s.shipment, `solo|${s.shipment}`)
      continue
    }
    if (!byVessel.has(vessel)) byVessel.set(vessel, [])
    byVessel.get(vessel).push({ s, etd })
  }

  for (const [vessel, rows] of byVessel) {
    // Sorted by date, then by id so a run is reproducible when two loads share a day.
    rows.sort((a, b) => a.etd - b.etd || byShipment(a.s, b.s))
    let key = null
    let prev = null
    for (const { s, etd } of rows) {
      if (prev === null || (etd - prev) / DAY > LOAD_WINDOW_DAYS) {
        // Named for the sailing's FIRST load. The date stays RAW: same YYYY-MM-DD field from the
        // same feed, so equal sailings give equal strings.
        key = `${vessel}|${s.actual_shipping}`
      }
      keys.set(s.shipment, key)
      prev = etd
    }
  }

  return keys
}

// When the ship is at a given container's discharge port. An ACTUAL arrival is truth; an expected
// one is what is left when there is no actual.
const callDate = (s) => parseYMD(s.actual_portdate) || parseYMD(s.expected_portdate)

/**
 * The ordered port calls of one sailing, and the legs between them.
 *
 * BUILT FROM EVERY SHIPMENT ON THE SAILING, WHATEVER STATE IT IS IN — and that is the part that is
 * easy to get wrong. Once the New York box reports an `actual_portdate` it is no longer `enroute`,
 * so an itinerary assembled from the containers still aboard would forget New York was ever called
 * at and snap the ship back onto a direct line to Norfolk. The manifest shrinks as boxes come off;
 * the itinerary does not.
 *
 * CALLS AT BOTH ENDS. A sailing loads at every distinct port of loading and discharges at every
 * distinct port of discharge, so Nhava Sheva -> Pipavav -> Los Angeles is three calls and two legs.
 * A load is dated by `actual_shipping` and a discharge by `actual_portdate` falling back to
 * `expected_portdate`.
 *
 * LOADS ALWAYS PRECEDE DISCHARGES, ordered by date within each half rather than merged into one
 * date sort. On an inbound feed that is simply true — every load happens before any discharge — and
 * asserting it means one bad date cannot interleave a load into the middle of the discharge chain
 * and send the ship back across an ocean.
 *
 * ONE CALL PER PORT COMPLEX, through facilityKey — the same fold `canonicalPort` applies to port
 * cards and `isIntermodal` to rail legs. MSC ANNA in the fixture discharges at both Los Angeles and
 * Long Beach; treating those as two calls invents a 13.6 km leg across one harbour, ordered by two
 * ETAs a day apart. They are one gateway, so they are one call.
 *
 * LATEST DATE WINS WITHIN A CALL, at both ends: a ship leaves when the last box is aboard, and
 * leaves again when the last box is off.
 *
 * A DISCHARGE CALL WITH NO DATE IS DROPPED — it can be neither ordered nor used to bound a leg. An
 * undated LOAD is not, when it is the only one: see the blank-ETD note below.
 *
 * @returns {{key,name,pol,etd,calls,legs,missingLeg}|null}
 */
function buildItinerary(key, rows, routesByKey) {
  const first = rows[0]

  const add = (map, port, date, kind) => {
    const k = facilityKey(port)
    if (!k || !date) return
    const id = `${kind}|${k}`
    const seen = map.get(id)
    if (!seen) map.set(id, { key: k, name: canonicalPort(port), date, kind })
    else if (date > seen.date) seen.date = date
  }

  const loadMap = new Map()
  const dischargeMap = new Map()
  for (const s of rows) {
    add(loadMap, s.port_of_loading, parseYMD(s.actual_shipping), 'load')
    add(dischargeMap, s.port_of_discharge, callDate(s), 'discharge')
  }

  const loads = [...loadMap.values()].sort((a, b) => a.date - b.date)

  // A BLANK PORT OF LOADING IS FATAL; A BLANK ETD IS NOT, and the asymmetry is the point. Without
  // an origin there is no first leg to look up and nothing to draw a ship along, so the sailing is
  // dropped exactly as a missing route always was. Without a departure date the lane is still
  // perfectly known — only how far along it is not — so the chain starts at an UNDATED load call,
  // computeProgress returns 0 for its leg, and the hull sits at the load port saying "on this lane,
  // distance unknown". Dropping it instead would take the container off the map altogether: it is
  // `enroute`, so no port card would catch it either.
  if (!loads.length) {
    const pol = first.port_of_loading
    if (!pol || !facilityKey(pol)) return null
    loads.push({ key: facilityKey(pol), name: canonicalPort(pol), date: null, kind: 'load' })
  }

  const ordered = [...loads, ...[...dischargeMap.values()].sort((a, b) => a.date - b.date)]

  // Legs run call1 -> call2 -> ..., each looked up by its two port NAMES rather than by a
  // container's derived `route` field. For a single-load single-discharge sailing the two are the
  // same string (`route` is built as "POL - POD"); otherwise they differ on purpose — the Norfolk
  // box's route says Cartagena -> Norfolk, and the Pipavav box's says Pipavav -> Los Angeles, while
  // the ship sails Cartagena -> New York -> Norfolk and Nhava Sheva -> Pipavav -> Los Angeles. The
  // ship's own path is what has to be drawn.
  const legs = []
  let from = ordered[0]
  let missingLeg = null

  for (const call of ordered.slice(1)) {
    // The same complex twice in a row is not a leg — a box discharged where another loaded, or two
    // berths of one gateway. Carry the later date forward so the next leg is still bounded right.
    if (from.key === call.key) {
      from = { ...from, date: call.date }
      continue
    }
    const raw = routesByKey?.get(normalizeKey(`${from.name} - ${call.name}`))
    // SMOOTHED HERE, AND ONLY HERE. searoute's output is the routed path of record and stays that
    // way in the database; what a leg carries is the drawn version of it (smoothRoute.js). Doing it
    // at leg construction means `positionOnItinerary` and the dashed `remaining` line read the SAME
    // array, so the hull cannot drift beside its own track — and only the ~23 lanes actually in use
    // are smoothed, rather than all 2,544 that useRoutes holds.
    const coords = raw ? smoothLane(raw) : raw
    if (!coords || coords.length < 2) {
      // TRUNCATE, DO NOT DISCARD. The containers are still aboard and still belong in the tray;
      // the map just stops claiming a path it has no geometry for. MapView reports this in DEV.
      missingLeg = `${from.name} - ${call.name}`
      break
    }
    legs.push({ from: from.name, to: call.name, coords, start: from.date, end: call.date })
    from = call
  }

  return {
    key,
    name: first.vessel,
    pol: ordered[0].name,
    etd: ordered[0].date,
    calls: ordered,
    legs,
    missingLeg,
  }
}

// THE INLAND LEG a container is on: one origin, one destination, one departure, one arrival.
// The same shape as voyageKey one leg lower, and for the same reasons — the ports pin the lane
// so the group can only be drawn on a track its containers are actually on, and the dates pin
// the movement so boxes that left the port on different days are not merged into one marker
// several hundred miles from half of them.
//
// FOUR FIELDS, NOT FIVE: a train has no name in this data. `port_of_discharge` and `Lastcy` are
// the endpoints of the rail lane exactly as POL and POD are of the sea lane, so they do the
// work `vessel` cannot.
//
// normalizeKey and NOT facilityKey, for the reason voyageKey gives. There is an extra guard
// here: isIntermodal already compared these two through facilityKey to decide this is rail at
// all, so a move INSIDE one port complex never reaches this line (§7). What remains are genuine
// inland legs, where Los Angeles -> Denver and Long Beach -> Denver are two different tracks.
const railKey = (s) => {
  const parts = [s.port_of_discharge, s.Lastcy, s.actual_portdate, s.expected_lastcy_date]
  if (parts.some((p) => !p || !String(p).trim())) return `solo|${s.shipment}`
  const [pod, cy, departed, due] = parts
  return `${normalizeKey(pod)}|${normalizeKey(cy)}|${departed}|${due}`
}

/**
 * @param {object[]} shipments
 * @param {Map<string, number[][]>} routesByKey  normalized "POL - POD" -> coordinates
 * @param {Map<string, number[]>} portPoints     port key -> [lng, lat] (src/data/places.js)
 * @returns {{vessels: object[], trains: object[], ports: object[]}} holders, each { kind, key,
 *   name, subtitle, containers[] }. A vessel carries `legs` (the itinerary's geometry) and `calls`
 *   rather than a single `coords`; a train carries `coords`; a facility carries `coordinates`.
 */
export function buildHolders(shipments, routesByKey, portPoints, railByKey) {
  const vessels = new Map()
  const ports = new Map()
  const trains = new Map()
  const origins = new Map()

  // ITINERARIES FIRST, over EVERY shipment — arrived and railed ones included. A sailing's calls
  // are a fact about the ship, not about whichever of its boxes happen to still be aboard, and the
  // loop below only ever sees the en-route ones.
  const sailings = new Map()
  const bySailing = new Map()
  // Clustered per vessel, so the key is looked up rather than computed from a row — a multi-load
  // sailing has no single row that identifies it. See assignSailings.
  const keyOf = assignSailings(shipments)
  for (const s of shipments) {
    const k = keyOf.get(s.shipment)
    if (!bySailing.has(k)) bySailing.set(k, [])
    bySailing.get(k).push(s)
  }
  for (const [k, rows] of bySailing) {
    const itinerary = buildItinerary(k, rows, routesByKey)
    if (itinerary) sailings.set(k, itinerary)
  }

  for (const s of shipments) {
    const state = shipmentState(s)

    if (state === 'arrived') {
      // Grouped by the FACILITY THE BOX IS AT, which is not always the discharge port — once an
      // inland leg is done the container lives at its Lastcy yard, and a card belongs there. A
      // facility holds what is in it, however it got there.
      //
      // Then folded through canonicalPort, which merges a two-port complex into one card: Long
      // Beach into Los Angeles, Port Everglades into Miami (src/data/places.js). Display only —
      // the container's own card in the tray still names the actual port it sits at.
      const here = currentFacility(s)
      const facility = canonicalPort(here)
      const key = facilityKey(here)
      if (!key) continue
      if (!ports.has(key)) ports.set(key, { key, name: facility, routeEnd: null, containers: [] })
      const g = ports.get(key)
      // Only a fallback anchor, for a facility with no row in us_ports / world_ports. Taken from
      // whichever container first offers a usable lane, not necessarily the first in the group.
      if (!g.routeEnd) {
        const c = railByKey?.get(normalizeKey(s.rail_route)) ?? routesByKey?.get(normalizeKey(seaLane(s)))
        if (c && c.length >= 2) g.routeEnd = c[c.length - 1]
      }
      g.containers.push(s)
      continue
    }

    if (state === 'rail') {
      // KEYED ON POD + LASTCY + BOTH DATES — a MOVEMENT, not a lane. Same endpoints and same
      // dates means the same train; anything else is a separate marker at its own point on the
      // track. See railKey.
      //
      // This replaced rail_route + both dates, which keyed on the DERIVED lane string rather
      // than on the two facilities it is assembled from — the same fault the sea side had.
      const coords = railByKey?.get(normalizeKey(s.rail_route))
      if (!coords || coords.length < 2) continue
      const key = railKey(s)
      if (!trains.has(key)) {
        trains.set(key, { key, lane: s.rail_route, coords, containers: [] })
      }
      trains.get(key).containers.push(s)
      continue
    }

    if (state === 'future') {
      // NOT SAILED YET, so the box is sitting at the port it will load from. It used to be drawn
      // nowhere at all — `state !== 'enroute'` dropped it here, and MapView's header said
      // "future -> deferred" — which left it counted in the Overview and findable by search but
      // absent from the map, the one place you would look for it.
      //
      // ITS OWN KIND, NOT A PORT CARD. A facility card says "these boxes have stopped and the
      // question is what to clear next", and its whole colour language is about dwell: red at
      // three days, green once an appointment exists. A container waiting to load has no dwell
      // and no demurrage risk, so folding it into that vocabulary would say something false about
      // it. The `origin|` prefix also means a port that is BOTH an origin and a destination — not
      // in today's data, where load ports are international and discharge ports are not, but
      // entirely possible — keeps two cards rather than merging waiting boxes with landed ones.
      const here = s.port_of_loading
      const pk = facilityKey(here)
      if (!pk) continue
      const key = `origin|${pk}`
      if (!origins.has(key)) {
        origins.set(key, { key, portKey: pk, name: canonicalPort(here), routeStart: null, containers: [] })
      }
      const g = origins.get(key)
      // The mirror of the arrived branch's routeEnd: a fallback anchor for a load port with no row
      // in world_ports. Taken from the leg that DEPARTS this port — not the sailing's first leg,
      // which on a multi-load sailing starts somewhere else entirely: a box waiting at Pipavav
      // would otherwise be anchored at Nhava Sheva.
      if (!g.routeStart) {
        const legs = sailings.get(keyOf.get(s.shipment))?.legs ?? []
        const leg = legs.find((l) => facilityKey(l.from) === pk) ?? legs[0]
        if (leg?.coords?.length >= 2) g.routeStart = leg.coords[0]
      }
      g.containers.push(s)
      continue
    }

    if (state !== 'enroute') continue

    // ONE SAILING, not a ship and not a lane. The itinerary was built above from every container
    // booked on it; what goes in the holder here is the MANIFEST, which is only the boxes actually
    // aboard right now. That is what makes the count badge move with no special case at either end
    // — a box not yet loaded is `future` and waits on an origin card, a discharged one stops being
    // `enroute` — so the number rises as the ship loads down the coast and falls as it discharges.
    const itinerary = sailings.get(keyOf.get(s.shipment))
    // No first leg means no geometry at all to draw on — the same miss that used to drop a
    // container whose lane was not in sea_routes.
    if (!itinerary?.legs.length) continue
    if (!vessels.has(itinerary.key)) vessels.set(itinerary.key, { itinerary, containers: [] })
    vessels.get(itinerary.key).containers.push(s)
  }

  return {
    vessels: [...vessels.values()].map(({ itinerary, containers }) => {
      containers.sort(byShipment)
      // THE LEG THE SHIP IS ON NOW, from the same function MapView positions the icon with. The
      // tray reads `etd`/`eta` to say "DEPARTED 6 DAYS AGO / ETA 4 Oct", and on a multi-drop the
      // honest answer to both is about the CURRENT leg: once New York is behind it, the ship
      // departed New York and is due at Norfolk. Reading the sailing's original ETD against the
      // final call would describe a voyage nobody is waiting on.
      const active = activeLegAt(itinerary.legs)
      return {
        kind: 'vessel',
        key: itinerary.key,
        name: itinerary.name || '(unnamed vessel)',
        // The whole chain — the CALLS alone. It used to be `[pol, ...calls]`, from when the port of
        // loading sat outside the call list; now that loading IS the first call, that spelled the
        // first port twice ("Cartagena → Cartagena → New York → Norfolk").
        //
        // Used by the DEV logs and the missing-leg warning; the TRAY shows `manifest` instead,
        // which answers the question a reader actually has.
        subtitle: itinerary.calls.map((c) => c.name).join(' → '),
        // ONE LINE PER LANE ABOARD, with what is on it:
        //
        //     Cartagena, Colombia - New York, NY    3 containers
        //     Cartagena, Colombia - Norfolk, VA     1 container
        //
        // Each line names the lane THE BOX WAS BOOKED ON — its own load port to its own discharge
        // port. Not the sailing's first call: on a multi-load sailing the Pipavav box was never at
        // Nhava Sheva, and reading "Nhava Sheva - Los Angeles" against it would be false. The chain
        // in `subtitle` is how the ship gets there; this is what it carries and where each box
        // comes off.
        //
        // Built from the MANIFEST, so a lane with nothing aboard is simply absent and the tray
        // reads as work outstanding rather than history — once New York is discharged the vessel
        // reads as a Norfolk delivery.
        //
        // Ordered by the itinerary, so the lines run in the order the boxes will actually land.
        manifest: (() => {
          const byLane = new Map()
          for (const c of containers) {
            const pod = facilityKey(c.port_of_discharge)
            const lane = `${canonicalPort(c.port_of_loading)} - ${canonicalPort(c.port_of_discharge)}`
            const seen = byLane.get(lane)
            if (seen) seen.count += 1
            else byLane.set(lane, { key: lane, name: canonicalPort(c.port_of_discharge), lane, pod, count: 1 })
          }
          const order = new Map(itinerary.calls.map((call, i) => [call.key, i]))
          return [...byLane.values()].sort(
            (a, b) => (order.get(a.pod) ?? Infinity) - (order.get(b.pod) ?? Infinity) ||
              a.lane.localeCompare(b.lane),
          )
        })(),
        legs: itinerary.legs,
        calls: itinerary.calls,
        // The leg that has no polyline, if the itinerary was cut short at one. MapView reports it;
        // nothing decides anything on it.
        missingLeg: itinerary.missingLeg,
        etd: active?.leg.start ?? itinerary.etd,
        eta: active?.leg.end ?? null,
        containers,
      }
    }),
    // One holder per movement along a rail lane. Positioned exactly like a vessel — the same
    // progress and interpolation helpers — because it is the same problem: a thing travelling a
    // polyline between two dates.
    trains: [...trains.values()].map((t) => {
      t.containers.sort(byShipment)
      return {
        kind: 'rail',
        key: t.key,
        name: t.lane,
        subtitle: 'Inland rail',
        coords: t.coords,
        // Every container in this group shares both dates by construction — that is half the
        // grouping key — so the first row's are the group's.
        etd: parseYMD(t.containers[0]?.actual_portdate),
        eta: parseYMD(t.containers[0]?.expected_lastcy_date),
        // Same guard the vessel holders carry: the group agrees on POD and Lastcy by
        // construction, but `rail_route` is a separate derived field and is what the track
        // polyline is looked up by. A route contradicting its own endpoints draws the train on
        // the wrong line.
        lanes: [...new Set(t.containers.map((c) => c.rail_route).filter(Boolean))],
        containers: t.containers,
      }
    }),
    // ORIGINS RIDE IN THE SAME ARRAY AS PORT CARDS, and that is a drawing decision rather than a
    // modelling one: MapView's card pass takes this list and an origin wants the same geometry at
    // the same anchor. Only the identity and the words differ — `kind: 'origin'`, an `origin|`
    // key that cannot collide with a discharge card, and "Port of loading" beneath the name.
    ports: [
      ...[...origins.values()].map((o) => {
        o.containers.sort(byShipment)
        return {
          kind: 'origin',
          key: o.key,
          // The name the ANCHOR is looked up by. It is not the holder key here, because that
          // carries the `origin|` prefix, and MapView resolves coordinates through this.
          portKey: o.portKey,
          name: o.name,
          subtitle: 'Port of loading',
          coordinates: portPoints?.get(o.portKey) ?? o.routeStart,
          containers: o.containers,
        }
      }),
      ...[...ports.values()].map((p) => {
        p.containers.sort(byShipment)
        return {
          kind: 'port',
          key: p.key,
          portKey: p.key,
          name: p.name,
          // A facility is not always a seaport now: an inland yard holds containers that finished
          // a rail leg. The label follows the place rather than assuming the sea.
          // Compared through facilityKey on BOTH sides, or a container whose Lastcy is Long Beach
          // would never match a card keyed on Los Angeles.
          subtitle: p.containers.some(
            (c) => facilityKey(c.Lastcy) === p.key && facilityKey(c.port_of_discharge) !== p.key,
          )
            ? 'Inland container yard'
            : 'Port of discharge',
          // The PORT's own coordinate — the exact point its label is drawn at. The sea route's
          // last vertex is a lane-graph node near the port, not the port, so it is only a fallback.
          coordinates: portPoints?.get(p.key) ?? p.routeEnd,
          containers: p.containers,
        }
      }),
    ],
  }
}

// The same VESSEL NAME appearing as more than one holder. Not used to decide anything — it is
// what the DEV log reports.
//
// SHARPER THAN IT USED TO BE. While a holder was one voyage, a name in two places could mean
// either "two sailings" or "one sailing cut in half by its own PODs", and the log could not tell
// you which — the multi-drop case looked exactly like the genuine one. Now that a sailing carries
// its whole itinerary, the second reading is gone: two holders of one name are two departures.
//
// Often that is not a fault at all. INBSHIP3893 / INBSHIP3894 are two real WAN HAI 272 sailings
// from Bangkok, three months apart. The log says what happened and leaves the judgement to
// whoever reads it.
export function vesselSplits(vesselHolders) {
  const byName = new Map()
  for (const v of vesselHolders) {
    const n = normalizeKey(v.name)
    if (!byName.has(n)) byName.set(n, [])
    byName.get(n).push(v)
  }
  const out = []
  for (const [, group] of byName) {
    if (group.length < 2) continue
    out.push({
      vessel: group[0].name,
      voyages: group.map((v) => ({
        route: v.subtitle,
        containers: v.containers.length,
        // The SAILING's departure, which is in the key, rather than any one box's — and the last
        // call it makes, which is the end of the itinerary rather than the end of a leg.
        etd: v.containers[0]?.actual_shipping || '—',
        eta: v.calls?.[v.calls.length - 1]?.date?.toISOString().slice(0, 10) || '—',
      })),
    })
  }
  return out
}
