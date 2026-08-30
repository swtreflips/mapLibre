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
  normalizeKey,
  parseYMD,
  shipmentState,
  currentFacility,
  canonicalPort,
  facilityKey,
} from './vesselMath'

// The sea lane. Two spellings are live: `route` on shipments that end at their discharge port, and
// `sea_route` on intermodal ones that also carry a `rail_route`. Neither column exists in the
// production schema yet (CLAUDE.md §14), so both have to work — and reading only `route` would
// silently drop an intermodal shipment that is still at sea, because the lane lookup would miss
// and the loop would skip it.
const seaLane = (s) => s.sea_route ?? s.route

// Sorted by shipment id so a container keeps its slot in a card stack and its row in the tray
// across refreshes, rather than shuffling when the data reloads.
const byShipment = (a, b) => (a.shipment < b.shipment ? -1 : a.shipment > b.shipment ? 1 : 0)

// THE VOYAGE a container is aboard: one hull, one departure, one arrival. Containers group only
// when all three agree.
//
// Two ways out into a holder of one, and both are the rule being honest rather than exceptions to
// it. A blank VESSEL NAME cannot be shared — every unnamed row would otherwise collapse into a
// single ghost ship on whatever dates they happened to have in common. And a MISSING DATE is not a
// value two rows can match on: two unknowns are not the same unknown, and treating them as one
// would put containers on a hull because of what the feed failed to say about them.
//
// Falling back to the shipment id makes those rows individually keyed, so they stand alone.
const voyageKey = (s) =>
  s.vessel?.trim() && s.actual_shipping && s.expected_portdate
    ? `${normalizeKey(s.vessel)}|${s.actual_shipping}|${s.expected_portdate}`
    : `solo|${s.shipment}`

/**
 * @param {object[]} shipments
 * @param {Map<string, number[][]>} routesByKey  normalized "POL - POD" -> coordinates
 * @param {Map<string, number[]>} portPoints     port key -> [lng, lat] (src/data/places.js)
 * @returns {{vessels: object[], ports: object[]}} holders, each { kind, key, name, subtitle,
 *   coordinates|route, containers[] }
 */
export function buildHolders(shipments, routesByKey, portPoints, railByKey) {
  const vessels = new Map()
  const ports = new Map()
  const trains = new Map()

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
      // KEYED ON LANE + BOTH DATES. The lane alone would merge boxes that left the port on
      // different days into one marker, and they are genuinely at different points on the track.
      // Same lane and same dates means the same movement — a train.
      const coords = railByKey?.get(normalizeKey(s.rail_route))
      if (!coords || coords.length < 2) continue
      const key = `${normalizeKey(s.rail_route)}|${s.actual_portdate}|${s.expected_lastcy_date}`
      if (!trains.has(key)) {
        trains.set(key, { key, lane: s.rail_route, coords, containers: [] })
      }
      trains.get(key).containers.push(s)
      continue
    }

    if (state !== 'enroute') continue

    // KEYED ON VESSEL + ETD + ETA — a VOYAGE, not a ship and not a lane.
    //
    // Containers ride the same hull only if all three match. Same ship on different dates is a
    // different sailing, and anything that fails to match gets its own holder rather than being
    // folded in on the strength of the name alone.
    //
    // This replaced vessel + route, which grouped on the LANE and so quietly asserted that every
    // container Cartagena -> New York on a ship called CAUTIN was aboard the same hull, whatever
    // their dates said. That is how the fixture came to hold a "3 containers" badge over rows whose
    // ETAs were a month apart — the number was real, the voyage behind it was not.
    //
    // The dates are compared as RAW STRINGS, deliberately: they are the same "YYYY-MM-DD" field
    // from the same feed, so equal voyages give equal keys, and parsing first would only add a way
    // for two identical strings to disagree.
    const coords = routesByKey?.get(normalizeKey(seaLane(s)))
    if (!coords || coords.length < 2) continue
    const key = voyageKey(s)
    if (!vessels.has(key)) {
      vessels.set(key, { key, name: s.vessel, route: seaLane(s), coords, containers: [] })
    }
    vessels.get(key).containers.push(s)
  }

  return {
    vessels: [...vessels.values()].map((v) => {
      v.containers.sort(byShipment)
      return {
        kind: 'vessel',
        key: v.key,
        name: v.name || '(unnamed vessel)',
        subtitle: v.route,
        coords: v.coords,
        // EVERY lane in the group, not just the one it is drawn on. Route is deliberately
        // not part of the key — the rule is vessel + ETD + ETA — so a hull sailing one
        // voyage can in principle arrive here carrying containers booked on two different
        // lanes. Only one polyline can position the icon, so the rest would be plotted on a
        // route their containers did not take. That is the one silent wrong answer this
        // grouping can give, so the group carries the evidence and the DEV log names it.
        lanes: [...new Set(v.containers.map(seaLane).filter(Boolean))],
        // Every container here shares both dates BY CONSTRUCTION — they are two thirds of the
        // grouping key — so the first row's are the group's. This used to be voyageEta/voyageEtd,
        // which took the latest and earliest across a group that could legitimately disagree;
        // grouping on the dates means it no longer can, and the same reconciliation the rail
        // branch does below now applies here.
        etd: parseYMD(v.containers[0]?.actual_shipping),
        eta: parseYMD(v.containers[0]?.expected_portdate),
        containers: v.containers,
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
        // Every container in this group shares both dates by construction — that is the grouping
        // key — so the first row's are the group's.
        etd: parseYMD(t.containers[0]?.actual_portdate),
        eta: parseYMD(t.containers[0]?.expected_lastcy_date),
        containers: t.containers,
      }
    }),
    ports: [...ports.values()].map((p) => {
      p.containers.sort(byShipment)
      return {
        kind: 'port',
        key: p.key,
        name: p.name,
        // A facility is not always a seaport now: an inland yard holds containers that finished a
        // rail leg. The label follows the place rather than assuming the sea.
        // Compared through facilityKey on BOTH sides, or a container whose Lastcy is Long Beach
        // would never match a card keyed on Los Angeles.
        subtitle: p.containers.some(
          (c) => facilityKey(c.Lastcy) === p.key && facilityKey(c.port_of_discharge) !== p.key,
        )
          ? 'Inland container yard'
          : 'Port of discharge',
        // The PORT's own coordinate — the exact point its label is drawn at. The sea route's last
        // vertex is a lane-graph node near the port, not the port, so it is only a fallback.
        coordinates: portPoints?.get(p.key) ?? p.routeEnd,
        containers: p.containers,
      }
    }),
  }
}

// The same VESSEL NAME appearing as more than one holder. Not used to decide anything — it is
// what the DEV log reports.
//
// This replaced etaDisagreements, and the swap is the whole shape of the grouping change.
// Disagreeing dates inside one group used to be possible, so they had to be detected and resolved
// (the vessel was drawn at the latest of them). Now the dates ARE the key, so a group cannot
// disagree with itself — the disagreement did not disappear, it moved: it shows up as one ship
// name standing in two places, which is both more honest and much easier to see on the map.
//
// Often it is not a fault at all. A ship really does sail many voyages, and INBSHIP3893 /
// INBSHIP3894 are two genuine WAN HAI 272 sailings to different coasts. The log says what happened
// and leaves the judgement to whoever reads it.
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
        etd: v.containers[0]?.actual_shipping || '—',
        eta: v.containers[0]?.expected_portdate || '—',
      })),
    })
  }
  return out
}
