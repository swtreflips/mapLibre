// Regression test for the two GROUPING rules in src/lib/holders.js.
//
//   npm run test:grouping
//
// WHY THIS EXISTS. Containers share a marker only on an exact multi-field match:
//
//   vessel  vessel + port of loading + ETD          (the SAILING; its calls become an itinerary)
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
const { normalizeKey, positionOnItinerary } = await import(VESSEL_MATH)

let failed = 0
const check = (name, got, want) => {
  const ok = got === want
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got ${got}, want ${want}`}`)
}

// Lanes with real coordinates, so nothing is dropped for want of a polyline.
//
// THE PORT-TO-PORT ONES MATTER AS MUCH AS THE OCEAN ONES NOW. A sailing that calls twice needs a
// leg BETWEEN its two calls, and that leg is looked up exactly like any other — New York -> Norfolk
// is a real 568.9 km row in `sea_routes` since the US matrix landed. Note what is deliberately
// ABSENT: `New York, NY - Savannah, GA`, which the truncation case below depends on missing.
const routes = new Map([
  [normalizeKey('Bangkok, Thailand - New York, NY'), [[100, 13], [-74, 40]]],
  [normalizeKey('Bangkok, Thailand - Los Angeles, CA'), [[100, 13], [-118, 33]]],
  [normalizeKey('Bangkok, Thailand - Long Beach, CA'), [[100, 13], [-118.2, 33.7]]],
  [normalizeKey('Cartagena, Colombia - New York, NY'), [[-75, 10], [-74, 40]]],
  [normalizeKey('New York, NY - Norfolk, VA'), [[-74, 40], [-76.3, 36.9]]],
  [normalizeKey('New York, NY - Los Angeles, CA'), [[-74, 40], [-118, 33]]],
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
  ['identical in all three -> ONE sailing', [ship({ shipment: 'A' }), ship({ shipment: 'B' })], 1],

  ['different VESSEL -> two', [
    ship({ shipment: 'A' }), ship({ shipment: 'B', vessel: 'OTHER SHIP' })], 2],
  ['different ETD -> two', [
    ship({ shipment: 'A' }), ship({ shipment: 'B', actual_shipping: '2026-06-02' })], 2],

  // ETD is what pins the sailing, so a differing ETA no longer splits the hull. Two boxes off the
  // same departure arriving on different days are one ship making two calls — see the multi-drop
  // section below, which is where that case is actually asserted.
  ['different ETA -> still ONE, as two calls', [
    ship({ shipment: 'A' }),
    ship({ shipment: 'B', expected_portdate: '2026-12-02',
           port_of_discharge: 'Los Angeles, CA', Lastcy: 'Los Angeles, CA' })], 1],

  ['different PORT OF LOADING -> two', [
    ship({ shipment: 'A' }),
    ship({ shipment: 'B', port_of_loading: 'Cartagena, Colombia',
           route: 'Cartagena, Colombia - New York, NY' })], 2],

  // WAS TWO. A different discharge port used to mean a different holder, which is exactly the bug
  // the itinerary fixes: it drew one hull as two markers, the second on a lane it never sails.
  ['different PORT OF DISCHARGE -> ONE sailing, two calls', [
    ship({ shipment: 'A' }),
    ship({ shipment: 'B', port_of_discharge: 'Los Angeles, CA', Lastcy: 'Los Angeles, CA',
           expected_portdate: '2026-12-20', route: 'Bangkok, Thailand - Los Angeles, CA' })], 1],

  // WAS TWO, DELIBERATELY REVERSED. The old rule kept LA and Long Beach apart because a holder
  // could only be drawn along one polyline, and folding them would have handed the group one lane
  // out of two. An itinerary has a leg per call, so that reason is gone — and keeping them apart
  // now costs a spurious 13.6 km leg across one harbour, ordered by two ETAs a day apart. They
  // are one gateway everywhere else in the app (facilityKey), and now here too.
  ['Los Angeles + Long Beach -> ONE call, folded by PORT_ALIASES', [
    ship({ shipment: 'A', port_of_discharge: 'Los Angeles, CA', Lastcy: 'Los Angeles, CA',
           route: 'Bangkok, Thailand - Los Angeles, CA' }),
    ship({ shipment: 'B', port_of_discharge: 'Long Beach, CA', Lastcy: 'Long Beach, CA',
           expected_portdate: '2026-12-02', route: 'Bangkok, Thailand - Long Beach, CA' })], 1],

  // Port names are not normalised at the source (CLAUDE.md §4), so a sailing must not split on
  // capitalisation or comma spacing.
  ['same ports, different SPELLING -> still ONE', [
    ship({ shipment: 'A' }),
    ship({ shipment: 'B', port_of_loading: 'BANGKOK,  THAILAND', port_of_discharge: 'new york, ny' })], 1],
  ['same vessel, different CASE -> still ONE', [
    ship({ shipment: 'A' }), ship({ shipment: 'B', vessel: 'test ship' })], 1],

  // ── Ungroupable rows stand alone rather than collapsing together. ───────────────────
  ['blank VESSEL -> each alone', [
    ship({ shipment: 'A', vessel: '' }), ship({ shipment: 'B', vessel: '' })], 2],
  // Still drawn, one apiece: the lane is known and only the progress along it is not, so the hull
  // sits at the load port rather than vanishing off a map where nothing else would catch it.
  ['blank ETD -> each alone, still drawn', [
    ship({ shipment: 'A', actual_shipping: '' }), ship({ shipment: 'B', actual_shipping: '' })], 2],
  // No origin means no first leg and nothing to draw along — the same outcome a missing route has
  // always had.
  ['blank PORT OF LOADING -> no lane, so no holder', [
    ship({ shipment: 'A', port_of_loading: '' }), ship({ shipment: 'B', port_of_loading: '' })], 0],
  ['whitespace-only vessel -> each alone', [
    ship({ shipment: 'A', vessel: '   ' }), ship({ shipment: 'B', vessel: '   ' })], 2],

  // A CALL NEEDS A DATE. It can be neither ordered against the others nor used to bound a leg, so
  // it is dropped — and with no calls left there is no itinerary and no holder at all. These rows
  // are still keyed together, which is why the answer is 0 rather than 2.
  ['blank ETA and no arrival -> no call, so no holder', [
    ship({ shipment: 'A', expected_portdate: '' }), ship({ shipment: 'B', expected_portdate: '' })], 0],
  ['blank PORT OF DISCHARGE -> no call, so no holder', [
    ship({ shipment: 'A', port_of_discharge: '' }), ship({ shipment: 'B', port_of_discharge: '' })], 0],

  ['three containers, one sailing', [
    ship({ shipment: 'A' }), ship({ shipment: 'B' }), ship({ shipment: 'C' })], 1],
]

console.log('sailing grouping — vessel + POL + ETD\n')
for (const [name, rows, want] of CASES) check(name, holders(rows).length, want)

// ── The group's own reported facts ─────────────────────────────────────────────────────
console.log('\nwhat a grouped holder reports\n')
const one = holders([ship({ shipment: 'A' }), ship({ shipment: 'B' }), ship({ shipment: 'C' })])[0]
check('holds all three', one.containers.length, 3)
check('sorted by shipment id', one.containers.map((c) => c.shipment).join(''), 'ABC')
check('one ETD, read off the group', one.etd?.toISOString().slice(0, 10), '2026-06-01')
check('one ETA, read off the group', one.eta?.toISOString().slice(0, 10), '2026-12-01')
check('one call', one.calls.length, 1)
check('one leg', one.legs.length, 1)
check('nothing missing', one.missingLeg, null)

// ── MULTI-DROP: one hull, several calls ────────────────────────────────────────────────
//
// The case the whole grouping change exists for. Two boxes loaded together at Cartagena come off
// at New York on 4 Oct and Norfolk on 13 Oct. That is ONE ship making TWO calls — and keying on
// the discharge port drew it as two markers, the second on a direct Cartagena -> Norfolk lane the
// ship never sails.
//
// Dates are far future so the sailing stays `enroute` whenever this runs.
console.log('\nmulti-drop sailings\n')

const drop = (over) => ship({
  port_of_loading: 'Cartagena, Colombia',
  port_of_discharge: 'New York, NY',
  Lastcy: 'New York, NY',
  route: 'Cartagena, Colombia - New York, NY',
  expected_portdate: '2099-10-04',
  ...over,
})
const NORFOLK = {
  port_of_discharge: 'Norfolk, VA',
  Lastcy: 'Norfolk, VA',
  route: 'Cartagena, Colombia - Norfolk, VA',
  expected_portdate: '2099-10-13',
}

const multi = holders([drop({ shipment: 'A' }), drop({ shipment: 'B', ...NORFOLK })])
check('two PODs, one sailing', multi.length, 1)
check('...carrying both boxes', multi[0].containers.length, 2)
check('...as two calls', multi[0].calls.length, 2)
check('...in date order', multi[0].calls.map((c) => c.name).join(' > '), 'New York, NY > Norfolk, VA')
check('...over two legs', multi[0].legs.length, 2)
check('...the second running between the two ports', multi[0].legs[1].from + ' -> ' + multi[0].legs[1].to,
  'New York, NY -> Norfolk, VA')
check('...and the subtitle names the whole chain', multi[0].subtitle,
  'Cartagena, Colombia → New York, NY → Norfolk, VA')

// WHAT THE TRAY SHOWS: one line per destination, each named from the ORIGIN, because
// "Cartagena -> Norfolk" is the move that was booked. The chain is how the ship gets there.
check('...the tray lists a lane per destination',
  multi[0].manifest.map((m) => `${m.lane} (${m.count})`).join(' | '),
  'Cartagena, Colombia - New York, NY (1) | Cartagena, Colombia - Norfolk, VA (1)')

// ORDER COMES FROM THE DATES, not from row order. Feeding the later call first must not reverse
// the itinerary and send the ship to Norfolk before New York.
const reversed = holders([drop({ shipment: 'A', ...NORFOLK }), drop({ shipment: 'B' })])
check('rows in reverse still order by date', reversed[0].calls.map((c) => c.name).join(' > '),
  'New York, NY > Norfolk, VA')

// THE ITINERARY OUTLIVES THE MANIFEST. Once the New York box lands it is no longer `enroute`, so
// it leaves the holder — but the call it made must not leave with it, or the ship snaps back onto
// a direct Cartagena -> Norfolk line it was never on.
const midVoyage = holders([
  drop({ shipment: 'A', expected_portdate: '2026-01-04', actual_portdate: '2026-01-04' }),
  drop({ shipment: 'B', ...NORFOLK }),
])
check('after the first call, one holder still', midVoyage.length, 1)
check('...carrying only what is still aboard', midVoyage[0].containers.length, 1)
check('...but remembering both calls', midVoyage[0].calls.length, 2)
check('...and still routed via New York', midVoyage[0].legs.length, 2)
// The discharged call drops out of the tray: what is left is work outstanding, not history.
check('...the tray now shows only Norfolk',
  midVoyage[0].manifest.map((m) => `${m.lane} (${m.count})`).join(' | '),
  'Cartagena, Colombia - Norfolk, VA (1)')
// The active leg is the one the tray describes and the hull rides. Past New York, both must be
// leg 2 — this is the assertion that the badge and the position moved together.
check('...with the active leg now New York -> Norfolk', midVoyage[0].eta?.toISOString().slice(0, 10),
  '2099-10-13')

// A LEG WITH NO GEOMETRY TRUNCATES THE CHAIN; it does not delete the ship.
const noLeg = holders([
  drop({ shipment: 'A' }),
  drop({ shipment: 'B', port_of_discharge: 'Savannah, GA', Lastcy: 'Savannah, GA',
         route: 'Cartagena, Colombia - Savannah, GA', expected_portdate: '2099-10-20' }),
])
check('missing middle leg -> holder survives', noLeg.length, 1)
check('...still carrying both boxes', noLeg[0].containers.length, 2)
check('...drawn only as far as it can be', noLeg[0].legs.length, 1)
check('...and it names the gap', noLeg[0].missingLeg, 'New York, NY - Savannah, GA')

// A missing FIRST leg is the old "no route, no holder" case, unchanged.
const noFirst = holders([drop({ shipment: 'A', port_of_loading: 'Nowhere, XX',
  route: 'Nowhere, XX - New York, NY' })])
check('missing first leg -> no holder', noFirst.length, 0)

// ── WHERE THE HULL ACTUALLY GOES ───────────────────────────────────────────────────────
//
// The grouping can be perfect and the map still wrong: MapView positions the icon with
// positionOnItinerary, and if that picks the wrong leg the ship is drawn hundreds of miles from
// where its own tray says it is. Nothing on screen would say so.
//
// Legs here are the synthetic two-point lanes at the top of this file, so a coordinate identifies
// the leg unambiguously: Cartagena(-75,10) -> New York(-74,40) -> Norfolk(-76.3,36.9).
console.log('\nposition along the itinerary\n')
{
  const legs = multi[0].legs
  // Mid-way down the first leg: before New York, so on the Cartagena line and with BOTH legs left
  // to draw. This is the user-visible "click the ship and see two polylines" case.
  const early = positionOnItinerary(legs, new Date(2099, 8, 1)) // 1 Sep 2099, ETA NY 4 Oct
  check('before the first call, on leg 1', early.index, 0)
  check('...with two dashed lines left', early.remaining.length, 2)
  check('...the second being the port-to-port leg',
    JSON.stringify(early.remaining[1]), JSON.stringify([[-74, 40], [-76.3, 36.9]]))

  // Between the calls: the leg the OLD model had no way to express at all.
  const between = positionOnItinerary(legs, new Date(2099, 9, 8)) // 8 Oct, NY 4 Oct -> Norfolk 13 Oct
  check('between the calls, on leg 2', between.index, 1)
  check('...with only one line left', between.remaining.length, 1)
  // Roughly 4/9 of the way from New York to Norfolk. The exact figure is computeProgress's job and
  // is tested elsewhere; what matters here is that it is on the RIGHT line, moving south-west.
  check('...south of New York', between.pos[1] < 40, true)
  check('...and west of it', between.pos[0] < -74, true)

  // Past every call, which is reachable while a box is aboard with no arrival reported. Held at
  // the last port rather than extrapolated off the end of the line.
  const after = positionOnItinerary(legs, new Date(2099, 11, 1))
  check('past the last call, held at the final port',
    JSON.stringify(after.pos), JSON.stringify([-76.3, 36.9]))
}

// ── vesselSplits: the diagnostic that replaced etaDisagreements ─────────────────────────
//
// Sharper than it was. While a holder was one voyage, a name in two places could mean two sailings
// OR one sailing cut in half by its own PODs, and the log could not tell you which. A sailing now
// carries its whole itinerary, so the second reading is gone: two holders of one name are two
// departures — which is why the split below is built from a different ETD, not a different ETA.
console.log('\nvesselSplits\n')
const split = holders([ship({ shipment: 'A' }), ship({ shipment: 'B', actual_shipping: '2026-07-01' })])
check('one name, two sailings -> reported', vesselSplits(split).length, 1)
check('and it names both', vesselSplits(split)[0].voyages.length, 2)
check('a clean sailing reports nothing', vesselSplits(holders([ship({ shipment: 'A' })])).length, 0)
check(
  'two different ships are not a split',
  vesselSplits(holders([ship({ shipment: 'A' }), ship({ shipment: 'B', vessel: 'OTHER' })])).length,
  0,
)
// The case that used to be a false positive: two calls are NOT two ships.
check('a multi-drop is not a split', vesselSplits(multi).length, 0)

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
  console.log(`      ${v.name} — ${v.subtitle}, ${v.containers.length} container(s), ` +
    `${v.calls.length} call(s)`)
}

// CAUTIN IS THE MULTI-DROP FIXTURE: three boxes to New York and one carried on to Norfolk, all on
// one departure. Under the old five-field voyage key this was TWO markers with one name.
const cautin = live.filter((v) => v.name === 'CAUTIN')
check('CAUTIN is ONE holder', cautin.length, 1)
check('holding all 4 containers', cautin[0]?.containers.length, 4)
check('across two calls', cautin[0]?.calls.length, 2)
check('New York first, then Norfolk',
  cautin[0]?.calls.map((c) => c.name).join(' > '), 'New York, NY > Norfolk, VA')
check('with geometry for both legs', cautin[0]?.legs.length, 2)

// MSC ANNA names Los Angeles AND Long Beach, which is one gateway and so one call — not a 13.6 km
// leg across its own harbour. (Its containers have all landed, so it draws no vessel; the check is
// on the itinerary the sailing would have.)
const anna = buildHolders(
  shipments.filter((s) => s.vessel === 'MSC ANNA').map((s) => ({ ...s, actual_portdate: '' })),
  realRoutes, new Map(), new Map(),
).vessels
check('MSC ANNA is ONE holder', anna.length, 1)
check('...calling once, LA and Long Beach folded', anna[0]?.calls.length, 1)
check('...named for the complex', anna[0]?.calls[0]?.name, 'Los Angeles, CA')

check('no vessel is drawn twice', vesselSplits(live).length, 0)
check('every holder has geometry to ride', live.every((v) => v.legs.length >= 1), true)
check('no holder is missing a leg', live.every((v) => !v.missingLeg), true)

console.log(failed === 0 ? '\nAll grouping checks passed.' : `\n${failed} check(s) FAILED.`)
process.exit(failed === 0 ? 0 : 1)
