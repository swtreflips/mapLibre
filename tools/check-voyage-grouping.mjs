// Regression test for the two GROUPING rules in src/lib/holders.js.
//
//   npm run test:grouping
//
// WHY THIS EXISTS. Containers share a marker only on an exact multi-field match:
//
//   vessel  vessel + ETD + ETA + port of loading + port of discharge
//   rail            POD + Lastcy + actual_portdate + expected_lastcy_date
//
// The live fixture holds exactly ONE multi-container voyage and ONE single-container rail leg, so
// running the app demonstrates the vessel match succeeding and essentially nothing else — not one
// of the ways either rule has to fail, and not the rail rule at all.
//
// AND THE FAILURES ARE THE POINT, because every one of them is silent. Group two containers that
// are not on the same hull and you get a confident badge reading "2" over a marker drawn at a
// position that is right for only one of them. Split two that are, and the same ship appears twice.
// Neither throws, neither looks wrong on screen, and both are wrong.
//
// This was fabricated once already: keyed on vessel + route, a shared LANE was enough to assert a
// shared hull, and three containers with ETAs a month apart rendered as one voyage purely to give
// the count badge a number bigger than 1.

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
// Rail lanes, keyed the way railByKey is.
const rails = new Map([
  [normalizeKey('Los Angeles, CA - Denver, CO'), [[-118, 33], [-105, 39]]],
  [normalizeKey('Long Beach, CA - Denver, CO'), [[-118.2, 33.7], [-105, 39]]],
  [normalizeKey('Los Angeles, CA - Chicago, IL'), [[-118, 33], [-87, 41]]],
  [normalizeKey('New York, NY - Denver, CO'), [[-74, 40], [-105, 39]]],
])

const holders = (rows) => buildHolders(rows, routes, new Map(), rails).vessels
const trains = (rows) => buildHolders(rows, routes, new Map(), rails).trains

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

// ── The inland leg ─────────────────────────────────────────────────────────────────────
//
// Same shape as the voyage, one leg lower: POD + Lastcy + actual_portdate +
// expected_lastcy_date. Four fields rather than five because a train has no name here — the two
// facilities are the endpoints of the lane exactly as POL and POD are of the sea lane.
//
// A rail shipment must be INTERMODAL to exist at all (POD and Lastcy differ on canonical keys),
// and must have sailed and landed, so these rows carry an actual_portdate and a future
// expected_lastcy_date.
console.log('\nrail grouping — POD + Lastcy + both dates\n')

const railBase = {
  vessel: 'TEST SHIP',
  actual_shipping: '2026-06-01',
  expected_portdate: '2026-08-01',
  port_of_loading: 'Bangkok, Thailand',
  port_of_discharge: 'Los Angeles, CA',
  Lastcy: 'Denver, CO',
  sea_route: 'Bangkok, Thailand - Los Angeles, CA',
  rail_route: 'Los Angeles, CA - Denver, CO',
  actual_portdate: '2026-08-01',
  expected_lastcy_date: '2099-01-01', // far future, so the state stays `rail`
  appointment_date: '',
  arrival_notice: 'no',
  last_freeday: '',
  items: [],
}
const box = (over) => ({ ...railBase, ...over })

const RAIL_CASES = [
  ['identical in all four -> ONE train', [box({ shipment: 'A' }), box({ shipment: 'B' })], 1],

  ['different PORT OF DISCHARGE -> two', [
    box({ shipment: 'A' }),
    box({ shipment: 'B', port_of_discharge: 'New York, NY',
          rail_route: 'New York, NY - Denver, CO' })], 2],
  ['different LASTCY -> two', [
    box({ shipment: 'A' }),
    box({ shipment: 'B', Lastcy: 'Chicago, IL',
          rail_route: 'Los Angeles, CA - Chicago, IL' })], 2],
  ['different ACTUAL PORT DATE -> two', [
    box({ shipment: 'A' }), box({ shipment: 'B', actual_portdate: '2026-08-02' })], 2],
  ['different EXPECTED LASTCY DATE -> two', [
    box({ shipment: 'A' }), box({ shipment: 'B', expected_lastcy_date: '2099-02-02' })], 2],

  // Left the port on different days: genuinely at different points on the track, so drawing
  // them as one marker would put half the containers hundreds of miles from where they are.
  ['same lane, different departure days -> two markers', [
    box({ shipment: 'A', actual_portdate: '2026-08-01' }),
    box({ shipment: 'B', actual_portdate: '2026-08-05' })], 2],

  // LA and Long Beach are one gateway for CARDS, two different tracks here.
  ['Los Angeles vs Long Beach origin -> two, NOT folded', [
    box({ shipment: 'A' }),
    box({ shipment: 'B', port_of_discharge: 'Long Beach, CA',
          rail_route: 'Long Beach, CA - Denver, CO' })], 2],

  ['same facilities, different SPELLING -> still ONE', [
    box({ shipment: 'A' }),
    box({ shipment: 'B', port_of_discharge: 'LOS ANGELES,  CA', Lastcy: 'denver, co' })], 1],

  // Two unknowns are not the same unknown. A rail box with no CY date is still `rail`
  // (shipmentState), so this path is reachable.
  ['blank EXPECTED LASTCY DATE -> each alone', [
    box({ shipment: 'A', expected_lastcy_date: '' }),
    box({ shipment: 'B', expected_lastcy_date: '' })], 2],

  ['three boxes, one train', [
    box({ shipment: 'A' }), box({ shipment: 'B' }), box({ shipment: 'C' })], 1],
]

for (const [name, rows, want] of RAIL_CASES) check(name, trains(rows).length, want)

console.log('\nwhat a grouped train reports\n')
const train = trains([box({ shipment: 'A' }), box({ shipment: 'B' }), box({ shipment: 'C' })])[0]
check('holds all three', train.containers.length, 3)
check('one departure, read off the group', train.etd?.toISOString().slice(0, 10), '2026-08-01')
check('one CY date, read off the group', train.eta?.toISOString().slice(0, 10), '2099-01-01')
check('exactly one lane', train.lanes.length, 1)

// The rail equivalent of the sea side's mixed-lane guard: endpoints agree, but the derived
// rail_route string does not, so the marker would ride a track its own endpoints contradict.
const mixedRail = trains([
  box({ shipment: 'A' }),
  box({ shipment: 'B', rail_route: 'Long Beach, CA - Denver, CO' }),
])
check('same endpoints, contradictory rail_route -> ONE train', mixedRail.length, 1)
check('  ...and it reports BOTH lanes for the warning', mixedRail[0].lanes.length, 2)

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
