// HOLDERS — the things on the map that hold containers.
//
// The map was first built thinking in containers: one icon per container, one selection per
// shipment. The working model is the other way round. A container is always somewhere, and that
// somewhere is a VESSEL carrying it, a TRAIN carrying it, or a FACILITY it is sitting at. All
// three hold 1..N. Clicking any of them fills the tray with what it holds.
//
// This module owns the grouping and nothing else — no map, no projection, no React. It answers
// "what is where", and MapView decides how to draw it.

import { normalizeKey, parseYMD, shipmentState, currentFacility } from './vesselMath'
import { canonicalPort, facilityKey } from '../data/places'

// The sea lane. Two spellings are live: `route` on shipments that end at their discharge port, and
// `sea_route` on intermodal ones that also carry a `rail_route`. Neither column exists in the
// production schema yet (CLAUDE.md §14), so both have to work — and reading only `route` would
// silently drop an intermodal shipment that is still at sea, because the lane lookup would miss
// and the loop would skip it.
const seaLane = (s) => s.sea_route ?? s.route

// Sorted by shipment id so a container keeps its slot in a card stack and its row in the tray
// across refreshes, rather than shuffling when the data reloads.
const byShipment = (a, b) => (a.shipment < b.shipment ? -1 : a.shipment > b.shipment ? 1 : 0)

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

    // KEYED ON VESSEL + ROUTE, not vessel alone. One ship sails many lanes over a season, and the
    // route is also what supplies the polyline the group is positioned along — so a vessel serving
    // two lanes is genuinely two holders, in two places.
    const coords = routesByKey?.get(normalizeKey(seaLane(s)))
    if (!coords || coords.length < 2) continue
    const key = `${normalizeKey(s.vessel)}|${normalizeKey(seaLane(s))}`
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
        // ONE ETA FOR THE GROUP. Containers on the same ship arrive together, so rows that
        // disagree are stale, not two positions — see voyageEta.
        eta: voyageEta(v.containers),
        etd: voyageEtd(v.containers),
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

// The group's arrival date. Rows on one vessel+route can carry different expected_portdate values
// — they do in the current fixtures — but a ship is in one place, so the group needs one date.
//
// Takes the LATEST. A container cannot arrive before its ship does, so the furthest-out date is
// the only one consistent with every row in the group; picking the first row silently would just
// hide the disagreement.
export function voyageEta(containers) {
  let best = null
  for (const c of containers) {
    const d = parseYMD(c.expected_portdate)
    if (d && (!best || d > best)) best = d
  }
  return best
}

// Earliest departure in the group, for the same reason in reverse: the ship sailed once.
export function voyageEtd(containers) {
  let best = null
  for (const c of containers) {
    const d = parseYMD(c.actual_shipping)
    if (d && (!best || d < best)) best = d
  }
  return best
}

// Containers on one voyage whose dates disagree. Not used to decide anything — it is what the DEV
// log reports, so a data fault surfaces instead of being quietly averaged away.
export function etaDisagreements(vesselHolders) {
  const out = []
  for (const v of vesselHolders) {
    const dates = new Set(v.containers.map((c) => c.expected_portdate).filter(Boolean))
    if (dates.size > 1) out.push({ vessel: v.name, route: v.subtitle, dates: [...dates] })
  }
  return out
}
