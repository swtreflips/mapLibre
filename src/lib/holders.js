// HOLDERS — the things on the map that hold containers.
//
// The map was first built thinking in containers: one icon per container, one selection per
// shipment. The working model is the other way round. A container is always somewhere, and that
// somewhere is either a VESSEL carrying it or a PORT it is sitting at. Both hold 1..N. Clicking
// either fills the tray with what it holds.
//
// This module owns the grouping and nothing else — no map, no projection, no React. It answers
// "what is where", and MapView decides how to draw it.

import { normalizeKey, parseYMD, shipmentState } from './vesselMath'

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
export function buildHolders(shipments, routesByKey, portPoints) {
  const vessels = new Map()
  const ports = new Map()

  for (const s of shipments) {
    const state = shipmentState(s)

    if (state === 'arrived') {
      // Grouped by DISCHARGE PORT regardless of route or port of loading — a yard holds what is
      // in it, however it got there.
      const key = normalizeKey(s.port_of_discharge)
      if (!key) continue
      if (!ports.has(key)) ports.set(key, { key, name: s.port_of_discharge, routeEnd: null, containers: [] })
      const g = ports.get(key)
      // Only a fallback anchor, for a port with no row in us_ports / world_ports. Taken from
      // whichever container first offers a usable route, not necessarily the first in the group.
      if (!g.routeEnd) {
        const c = routesByKey?.get(normalizeKey(s.route))
        if (c && c.length >= 2) g.routeEnd = c[c.length - 1]
      }
      g.containers.push(s)
      continue
    }

    if (state !== 'enroute') continue

    // KEYED ON VESSEL + ROUTE, not vessel alone. One ship sails many lanes over a season, and the
    // route is also what supplies the polyline the group is positioned along — so a vessel serving
    // two lanes is genuinely two holders, in two places.
    const coords = routesByKey?.get(normalizeKey(s.route))
    if (!coords || coords.length < 2) continue
    const key = `${normalizeKey(s.vessel)}|${normalizeKey(s.route)}`
    if (!vessels.has(key)) {
      vessels.set(key, { key, name: s.vessel, route: s.route, coords, containers: [] })
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
    ports: [...ports.values()].map((p) => {
      p.containers.sort(byShipment)
      return {
        kind: 'port',
        key: p.key,
        name: p.name,
        subtitle: 'Port of discharge',
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
