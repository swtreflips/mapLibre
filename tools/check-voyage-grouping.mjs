// Regression test for the VOYAGE grouping rule in src/lib/holders.js.
//
//   npm run test:grouping
//
// WHY THIS EXISTS. Containers group into one vessel holder only when FIVE fields agree: vessel,
// ETD, ETA, port of loading, port of discharge. The live fixture contains exactly one multi-container
// voyage, so running the app demonstrates that five-way match succeeding and none of the ways it is
// supposed to fail.
//
// AND THE FAILURES ARE THE POINT. Every one of them is silent. Group two containers that are not on
// the same hull and you get a confident badge reading "2" over a ship drawn at a position that is
// right for one of them; split two that are, and the same vessel appears twice. Neither throws,
// neither looks wrong on screen, and both are wrong.
//
// The grouping was fabricated once already — keyed on vessel + route, so a shared LANE was enough to
// assert a shared hull, and three containers with ETAs a month apart rendered as one voyage purely
// to give the count badge a number bigger than 1.

import { readFileSync } from 'fs'
import { pathToFileURL } from 'url'

// holders.js imports './vesselMath' without an extension — Vite resolves that, node does not.
// Rewrite it to an absolute file URL and load the result as a data: module, so the test exercises
// the REAL file rather than a copy that can drift from it.
const ROOT = pathToFileURL(process.cwd() + '/').href
const VESSEL_MATH = new URL('src/lib/vesselMath.js', ROOT).href
const patched = readFileSync('src/lib/holders.js', 'utf8').replace(
  "from './vesselMath'",
  `from '${VESSEL_MATH}'`,
)
const { buildHolders, vesselSplits } = await import(
  'data:text/javascript;base64,' + Buffer.from(patched).toString('base64')
)
const { normalizeKey } = await import(VESSEL_MATH)

let failed = 0
const check = (name, got, want) => {
  const ok = got === want
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got ${got}, want ${want}`}`)
}

// Two lanes with real coordinates, so nothing is dropped for want of a polyline.
const routes = new Map([
  [normalizeKey('Bangkok, Thailand - New York, NY'), [[100, 13], [-74, 40]]],
  [normalizeKey('Bangkok, Thailand - Los Angeles, CA'), [[100, 13], [-118, 33]]],
  [normalizeKey('Bangkok, Thailand - Long Beach, CA'), [[100, 13], [-118.2, 33.7]]],
  [normalizeKey('Cartagena, Colombia - New York, NY'), [[-75, 10], [-74, 40]]],
])

// En route: sailed, not yet arrived.
const base = {
  vessel: 'TEST SHIP',
  actual_shipping: '2026-06-01',
  expected_portdate: '2026-12-01',
  port_of_loading: 'Bangkok, Thailand',
  port_of_discharge: 'New York, NY',
  Lastcy: 'New York, NY',
  route: 'Bangkok, Thailand - New York, NY',
  actual_portdate: '',
  appointment_date: '',
  arrival_notice: 'no',
  last_freeday: '',
  items: [],
}
const ship = (over) => ({ ...base, ...over })
const holders = (rows) => buildHolders(rows, routes, new Map(), new Map()).vessels

// ── One field at a time. Each row differs from the first in exactly ONE way. ───────────
const CASES = [
  ['identical in all five -> ONE voyage', [ship({ shipment: 'A' }), ship({ shipment: 'B' })], 1],

  ['different VESSEL -> two', [
    ship({ shipment: 'A' }), ship({ shipment: 'B', vessel: 'OTHER SHIP' })], 2],
  ['different ETD -> two', [
    ship({ shipment: 'A' }), ship({ shipment: 'B', actual_shipping: '2026-06-02' })], 2],
  ['different ETA -> two', [
    ship({ shipment: 'A' }), ship({ shipment: 'B', expected_portdate: '2026-12-02' })], 2],

  // The two the ports were added for. Before them, both of these grouped — and the second
  // container was drawn on a lane it was not booked on.
  ['different PORT OF LOADING -> two', [
    ship({ shipment: 'A' }),
    ship({ shipment: 'B', port_of_loading: 'Cartagena, Colombia',
           route: 'Cartagena, Colombia - New York, NY' })], 2],
  ['different PORT OF DISCHARGE -> two', [
    ship({ shipment: 'A' }),
    ship({ shipment: 'B', port_of_discharge: 'Los Angeles, CA', Lastcy: 'Los Angeles, CA',
           route: 'Bangkok, Thailand - Los Angeles, CA' })], 2],

  // LA and Long Beach are ONE gateway for port cards (facilityKey folds them). They are NOT one
  // voyage: the two lanes are different polylines, and a holder can only be drawn along one.
  ['Los Angeles vs Long Beach -> two, NOT folded by PORT_ALIASES', [
    ship({ shipment: 'A', port_of_discharge: 'Los Angeles, CA', Lastcy: 'Los Angeles, CA',
           route: 'Bangkok, Thailand - Los Angeles, CA' }),
    ship({ shipment: 'B', port_of_discharge: 'Long Beach, CA', Lastcy: 'Long Beach, CA',
           route: 'Bangkok, Thailand - Long Beach, CA' })], 2],

  // Port names are not normalised at the source (CLAUDE.md §4), so a voyage must not split on
  // capitalisation or comma spacing.
  ['same ports, different SPELLING -> still ONE', [
    ship({ shipment: 'A' }),
    ship({ shipment: 'B', port_of_loading: 'BANGKOK,  THAILAND', port_of_discharge: 'new york, ny' })], 1],
  ['same vessel, different CASE -> still ONE', [
    ship({ shipment: 'A' }), ship({ shipment: 'B', vessel: 'test ship' })], 1],

  // ── Ungroupable rows stand alone rather than collapsing together. ───────────────────
  ['blank VESSEL -> each alone', [
    ship({ shipment: 'A', vessel: '' }), ship({ shipment: 'B', vessel: '' })], 2],
  ['blank ETD -> each alone', [
    ship({ shipment: 'A', actual_shipping: '' }), ship({ shipment: 'B', actual_shipping: '' })], 2],
  ['blank ETA -> each alone', [
    ship({ shipment: 'A', expected_portdate: '' }), ship({ shipment: 'B', expected_portdate: '' })], 2],
  ['blank PORT OF LOADING -> each alone', [
    ship({ shipment: 'A', port_of_loading: '' }), ship({ shipment: 'B', port_of_loading: '' })], 2],
  ['blank PORT OF DISCHARGE -> each alone', [
    ship({ shipment: 'A', port_of_discharge: '' }), ship({ shipment: 'B', port_of_discharge: '' })], 2],
  ['whitespace-only vessel -> each alone', [
    ship({ shipment: 'A', vessel: '   ' }), ship({ shipment: 'B', vessel: '   ' })], 2],

  ['three containers, one voyage', [
    ship({ shipment: 'A' }), ship({ shipment: 'B' }), ship({ shipment: 'C' })], 1],
]

console.log('voyage grouping — vessel + ETD + ETA + POL + POD\n')
for (const [name, rows, want] of CASES) check(name, holders(rows).length, want)

// ── The group's own reported facts ─────────────────────────────────────────────────────
console.log('\nwhat a grouped holder reports\n')
const one = holders([ship({ shipment: 'A' }), ship({ shipment: 'B' }), ship({ shipment: 'C' })])[0]
check('holds all three', one.containers.length, 3)
check('sorted by shipment id', one.containers.map((c) => c.shipment).join(''), 'ABC')
check('one ETD, read off the group', one.etd?.toISOString().slice(0, 10), '2026-06-01')
check('one ETA, read off the group', one.eta?.toISOString().slice(0, 10), '2026-12-01')
check('exactly one lane', one.lanes.length, 1)

// ── vesselSplits: the diagnostic that replaced etaDisagreements ─────────────────────────
//
// Disagreeing dates inside one group used to be possible and had to be reconciled. Now the dates
// are part of the key, so the disagreement cannot live inside a group — it shows up as one ship
// name standing in two places, which is what this reports.
console.log('\nvesselSplits\n')
const split = holders([ship({ shipment: 'A' }), ship({ shipment: 'B', expected_portdate: '2026-12-09' })])
check('one name, two voyages -> reported', vesselSplits(split).length, 1)
check('and it names both', vesselSplits(split)[0].voyages.length, 2)
check('a clean voyage reports nothing', vesselSplits(holders([ship({ shipment: 'A' })])).length, 0)
check(
  'two different ships are not a split',
  vesselSplits(holders([ship({ shipment: 'A' }), ship({ shipment: 'B', vessel: 'OTHER' })])).length,
  0,
)

// ── The real fixture ───────────────────────────────────────────────────────────────────
console.log('\nthe live fixture\n')
const { default: shipments } = await import(new URL('src/data/inboundShipments.js', ROOT).href)
const realRoutes = new Map(routes)
for (const s of shipments) {
  for (const lane of [s.route, s.sea_route]) {
    if (lane && !realRoutes.has(normalizeKey(lane))) realRoutes.set(normalizeKey(lane), [[0, 0], [10, 10]])
  }
}
const live = buildHolders(shipments, realRoutes, new Map(), new Map()).vessels
for (const v of live) {
  const c = v.containers[0]
  console.log(`      ${v.name} — ${c.port_of_loading} -> ${c.port_of_discharge}, ` +
    `${c.actual_shipping}->${c.expected_portdate}, ${v.containers.length} container(s)`)
}
const cautin = live.filter((v) => v.name === 'CAUTIN')
check('CAUTIN is ONE holder', cautin.length, 1)
check('holding all 3 containers', cautin[0]?.containers.length, 3)
check('on a single lane', cautin[0]?.lanes.length, 1)
check('no vessel is drawn twice', vesselSplits(live).length, 0)
check('every holder has exactly one lane', live.every((v) => v.lanes.length === 1), true)

console.log(failed === 0 ? '\nAll grouping checks passed.' : `\n${failed} check(s) FAILED.`)
process.exit(failed === 0 ? 0 : 1)
