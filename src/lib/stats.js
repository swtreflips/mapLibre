// OVERVIEW STATS — the fleet in numbers, and the containers behind each one.
//
// Pure, like holders.js and search.js: no React, no map, no storage. It answers "how many, and
// which".
//
// EVERY CLASSIFICATION COMES FROM vesselMath. This file must never work out for itself whether a
// container is on water or at rest — the version that lived inside Sidebar.jsx did exactly that,
// with its own date arithmetic, and the two drifted: the panel reported 8 arrived while the map
// drew 7 at rest and 1 on rail, because "has an actual_portdate" counts a container riding a train
// as sitting in a yard it has not reached. One state machine, or two views of one fleet give two
// answers.

import { shipmentState, containerStatus, finalYardEta } from './vesselMath'

const DAY = 86400000
const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())

// How far ahead "arriving soon" looks. A week is the horizon a yard plans against.
export const SOON_DAYS = 7

/**
 * @param {object[]} shipments
 * @param {Date} today
 * @returns {{total: number, transit: object, atRest: object, ids: Record<string, Set<string>>}}
 *   Counts, plus the id Set behind each — because every number in the panel is a filter, and
 *   recomputing membership at click time would be a second copy of the same rule, free to drift
 *   from this one exactly as the old Sidebar copy drifted from the map.
 */
export function computeStats(shipments, today = new Date()) {
  const now = midnight(today)
  const ids = {
    water: new Set(),
    rail: new Set(),
    arrivingSoon: new Set(),
    overdue: new Set(),
    red: new Set(),
    blue: new Set(),
    green: new Set(),
    atRest: new Set(),
  }

  let future = 0

  for (const s of shipments ?? []) {
    const id = s?.shipment
    if (!id) continue
    const state = shipmentState(s, today)

    if (state === 'future') future += 1
    if (state === 'enroute') ids.water.add(id)
    if (state === 'rail') ids.rail.add(id)

    if (state === 'arrived') {
      ids.atRest.add(id)
      // The same tone the tray chip and the map's isometric stack use, so a red here and a red
      // there are the same container.
      const tone = containerStatus(s, today).tone
      if (ids[tone]) ids[tone].add(id)
    } else {
      // Still moving, so it has a CY arrival still ahead of it — or already behind it.
      const eta = finalYardEta(s)
      if (eta) {
        const days = (eta - now) / DAY
        if (days < 0) ids.overdue.add(id)
        else if (days <= SOON_DAYS) ids.arrivingSoon.add(id)
      }
    }
  }

  return {
    total: (shipments ?? []).length,
    future,
    transit: {
      water: ids.water.size,
      rail: ids.rail.size,
      arrivingSoon: ids.arrivingSoon.size,
      overdue: ids.overdue.size,
    },
    atRest: {
      total: ids.atRest.size,
      red: ids.red.size,
      blue: ids.blue.size,
      green: ids.green.size,
    },
    ids,
  }
}
