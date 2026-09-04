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
const { normalizeKey, positionOnItinerary, haversine } = await import(VESSEL_MATH)

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
  [normalizeKey('Nhava Sheva, India - Pipavav, India'), [[72.95, 18.95], [71.57, 20.92]]],
  [normalizeKey('Pipavav, India - Nhava Sheva, India'), [[71.57, 20.92], [72.95, 18.95]]],
  [normalizeKey('Nhava Sheva, India - Oakland, CA'), [[72.95, 18.95], [-122.3, 37.8]]],
  [normalizeKey('Oakland, CA - Los Angeles, CA'), [[-122.3, 37.8], [-118, 33]]],
  [normalizeKey('Pipavav, India - Los Angeles, CA'), [[71.57, 20.92], [-118, 33]]],
  [normalizeKey('Nhava Sheva, India - Los Angeles, CA'), [[72.95, 18.95], [-118, 33]]],
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
  // A DAY APART IS THE SAME SAILING. It used to be two, back when ETD was in the key verbatim —
  // but a ship loading over two days is one departure, and multi-load grouping had to stop treating
  // a differing ETD as a different hull. Beyond LOAD_WINDOW_DAYS it still is.
  ['ETD a day apart -> still ONE', [
    ship({ shipment: 'A' }), ship({ shipment: 'B', actual_shipping: '2026-06-02' })], 1],
  ['ETD beyond the load window -> two', [
    ship({ shipment: 'A' }), ship({ shipment: 'B', actual_shipping: '2026-07-15' })], 2],  // 44 days: a second voyage

  // ETD is what pins the sailing, so a differing ETA no longer splits the hull. Two boxes off the
  // same departure arriving on different days are one ship making two calls — see the multi-drop
  // section below, which is where that case is actually asserted.
  ['different ETA -> still ONE, as two calls', [
    ship({ shipment: 'A' }),
    ship({ shipment: 'B', expected_portdate: '2026-12-02',
           port_of_discharge: 'Los Angeles, CA', Lastcy: 'Los Angeles, CA' })], 1],

  // WAS TWO. A second load port inside the window is the ship calling twice on its way out, not a
  // second hull — see the multi-load section. Beyond the window it is a different voyage again.
  ['different PORT OF LOADING beyond the window -> two', [
    ship({ shipment: 'A' }),
    ship({ shipment: 'B', port_of_loading: 'Cartagena, Colombia', actual_shipping: '2026-07-15',
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
check('two calls: one load, one discharge', one.calls.length, 2)
check('...the first being the load', one.calls[0].kind, 'load')
check('one leg between them', one.legs.length, 1)
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
check('...as three calls: the load, then two discharges', multi[0].calls.length, 3)
check('...in order', multi[0].calls.map((c) => c.name).join(' > '),
  'Cartagena, Colombia > New York, NY > Norfolk, VA')
check('...over two legs', multi[0].legs.length, 2)
check('...the second running between the two ports', multi[0].legs[1].from + ' -> ' + multi[0].legs[1].to,
  'New York, NY -> Norfolk, VA')
check('...and the subtitle names the whole chain, each port ONCE', multi[0].subtitle,
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
  'Cartagena, Colombia > New York, NY > Norfolk, VA')

// THE ITINERARY OUTLIVES THE MANIFEST. Once the New York box lands it is no longer `enroute`, so
// it leaves the holder — but the call it made must not leave with it, or the ship snaps back onto
// a direct Cartagena -> Norfolk line it was never on.
const midVoyage = holders([
  drop({ shipment: 'A', expected_portdate: '2026-01-04', actual_portdate: '2026-01-04' }),
  drop({ shipment: 'B', ...NORFOLK }),
])
check('after the first call, one holder still', midVoyage.length, 1)
check('...carrying only what is still aboard', midVoyage[0].containers.length, 1)
check('...but remembering both discharges', midVoyage[0].calls.length, 3)
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

// ── MULTI-LOAD: one hull, two ports of loading ─────────────────────────────────
//
// The mirror of the multi-drop case, at the other end of the voyage. BUDAPEST loads at Nhava Sheva,
// works up the coast to Pipavav a week later, then crosses to Los Angeles.
//
// This is the case NO KEY BUILT FROM ONE ROW CAN HANDLE: the two boxes differ in port of loading
// AND in ETD, so `vessel + POL + ETD` put them on two hulls by construction. Grouping had to become
// a per-vessel clustering pass over the load dates (assignSailings).
console.log('\nmulti-load sailings\n')

const NHAVA = {
  port_of_loading: 'Nhava Sheva, India',
  port_of_discharge: 'Los Angeles, CA',
  Lastcy: 'Los Angeles, CA',
  route: 'Nhava Sheva, India - Los Angeles, CA',
  actual_shipping: '2026-06-01',
  expected_portdate: '2099-07-10',
}
const load = (over) => ship({ ...NHAVA, ...over })
const PIPAVAV = {
  port_of_loading: 'Pipavav, India',
  route: 'Pipavav, India - Los Angeles, CA',
  actual_shipping: '2026-06-08', // seven days later, the user's own example
}
{
  const both = holders([load({ shipment: 'A' }), load({ shipment: 'B', ...PIPAVAV })])
  check('two load ports, one sailing', both.length, 1)
  check('...carrying both boxes', both[0].containers.length, 2)
  check('...as three calls', both[0].calls.length, 3)
  check('...two of them loads', both[0].calls.filter((c) => c.kind === 'load').length, 2)
  check('...in date order', both[0].calls.map((c) => c.name).join(' > '),
    'Nhava Sheva, India > Pipavav, India > Los Angeles, CA')
  check('...over two legs', both[0].legs.length, 2)
  check('...the first being the coastal hop', `${both[0].legs[0].from} -> ${both[0].legs[0].to}`,
    'Nhava Sheva, India -> Pipavav, India')

  // EACH BOX KEEPS ITS OWN LANE. The Pipavav container was never at Nhava Sheva, so a manifest line
  // reading "Nhava Sheva - Los Angeles" against it would simply be false.
  check("...and the tray names each box's own lane",
    both[0].manifest.map((m) => `${m.lane} (${m.count})`).join(' | '),
    'Nhava Sheva, India - Los Angeles, CA (1) | Pipavav, India - Los Angeles, CA (1)')

  // Rows in the other order must not reverse the itinerary and sail the ship backwards.
  const rev = holders([load({ shipment: 'A', ...PIPAVAV }), load({ shipment: 'B' })])
  check('rows in reverse still order by load date', rev[0].calls.map((c) => c.name).join(' > '),
    'Nhava Sheva, India > Pipavav, India > Los Angeles, CA')
}

// THE LOAD WINDOW IS WHAT SEPARATES A SECOND CALL FROM A SECOND VOYAGE, and 21 days is the line.
// Gaps chain off the PREVIOUS load, so a ship working three ports over eighteen days stays one
// sailing rather than being cut at the first one.
{
  const inside = holders([load({ shipment: 'A' }), load({ shipment: 'B', ...PIPAVAV, actual_shipping: '2026-06-21' })])
  check('20 days apart -> one sailing', inside.length, 1)
  const outside = holders([load({ shipment: 'A' }), load({ shipment: 'B', ...PIPAVAV, actual_shipping: '2026-06-23' })])
  check('22 days apart -> two sailings', outside.length, 2)
  const chained = holders([
    load({ shipment: 'A' }),
    load({ shipment: 'B', ...PIPAVAV, actual_shipping: '2026-06-15' }),
    load({ shipment: 'C', ...PIPAVAV, port_of_loading: 'Mundra, India', actual_shipping: '2026-06-29' }),
  ])
  check('28 days end to end in 14-day steps -> still one sailing', chained.length, 1)
}

// A BOX NOT YET LOADED IS NOT ABOARD. It waits on an origin card at ITS OWN port while the ship is
// still at sea between the two — the state the live fixture is posed in.
{
  const soon = new Date(); soon.setDate(soon.getDate() + 4)
  const ago = new Date(); ago.setDate(ago.getDate() - 3)
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const rows = [
    load({ shipment: 'A', actual_shipping: ymd(ago) }),
    load({ shipment: 'B', ...PIPAVAV, actual_shipping: ymd(soon) }),
  ]
  const built = buildHolders(rows, routes, new Map([[normalizeKey('Pipavav, India'), [71.57, 20.92]]]), rails)
  check('mid-load: the ship carries only what is loaded', built.vessels[0]?.containers.length, 1)
  check('...but its itinerary still calls at Pipavav', built.vessels[0]?.calls.length, 3)
  check('...and the waiting box is on an origin card', built.ports[0]?.kind, 'origin')
  check("...at ITS port, not the sailing's first", built.ports[0]?.name, 'Pipavav, India')
}

// ── BOTH ENDS AT ONCE: two boxes, two origins, two destinations ─────────────────
//
// The case multi-load and multi-drop only cover separately. One box Pipavav -> Oakland, another
// Nhava Sheva -> Los Angeles, on one hull: it picks each up as its ETD comes due and sets each down
// as its port date comes due, so the chain interleaves four calls that no two containers share.
//
//     Pipavav (load 1) -> Nhava Sheva (load 2) -> Oakland (drop 1) -> Los Angeles (drop 2)
//
// WHAT MAKES THIS WORK IS THAT LOADS ARE ORDERED AS A BLOCK BEFORE DISCHARGES, each half by date,
// rather than everything merged into one date sort. On an inbound feed that holds by construction:
// every port of loading is one of the thirteen international ones and every discharge is US or
// Canadian, so no load can fall after a discharge. A trade where a ship discharged and then loaded
// again further along its route would need that rule revisited — it is an assumption about the
// lane, not a law.
console.log('\ntwo origins and two destinations on one hull\n')
{
  const A = { vessel: 'INTERLEAVE', appointment_date: '', arrival_notice: 'no', last_freeday: '', items: [] }
  const rows = [
    { ...A, shipment: 'BOX-1', port_of_loading: 'Pipavav, India', port_of_discharge: 'Oakland, CA',
      Lastcy: 'Oakland, CA', route: 'Pipavav, India - Oakland, CA',
      actual_shipping: '2026-06-01', expected_portdate: '2099-07-04', actual_portdate: '' },
    { ...A, shipment: 'BOX-2', port_of_loading: 'Nhava Sheva, India', port_of_discharge: 'Los Angeles, CA',
      Lastcy: 'Los Angeles, CA', route: 'Nhava Sheva, India - Los Angeles, CA',
      actual_shipping: '2026-06-08', expected_portdate: '2099-07-11', actual_portdate: '' },
  ]
  const v = holders(rows)[0]
  check('two origins and two destinations -> ONE hull', holders(rows).length, 1)
  check('...four calls', v.calls.length, 4)
  check('...load, load, discharge, discharge', v.calls.map((c) => c.kind).join(','),
    'load,load,discharge,discharge')
  check('...in sailing order', v.subtitle,
    'Pipavav, India → Nhava Sheva, India → Oakland, CA → Los Angeles, CA')
  check('...over three legs', v.legs.length, 3)
  check('...including the US coastal hop', `${v.legs[2].from} -> ${v.legs[2].to}`,
    'Oakland, CA -> Los Angeles, CA')
  // Neither box shares a lane with the other, so the tray must name two.
  check('...and the tray names both lanes',
    v.manifest.map((m) => `${m.lane} (${m.count})`).join(' | '),
    'Pipavav, India - Oakland, CA (1) | Nhava Sheva, India - Los Angeles, CA (1)')

  // Dropping the Oakland box must not shorten the chain: the itinerary is a fact about the ship.
  const dropped = holders([{ ...rows[0], actual_portdate: '2026-06-30' }, rows[1]])[0]
  check('after Oakland, one box aboard', dropped.containers.length, 1)
  check('...only its lane in the tray', dropped.manifest.map((m) => m.lane).join(''),
    'Nhava Sheva, India - Los Angeles, CA')
  check('...and the chain is still four calls', dropped.calls.length, 4)
}

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

  // A SHORT LEG WITH SLACK HOLDS AT ITS MIDPOINT. New York -> Norfolk is ~400 km here (568.9 in
  // sea_routes), about twenty hours of steaming, and the fixture gives it nine days. Both halves of
  // the model cap at half the leg, so the ship reaches the middle and waits there for the inbound
  // clock — rather than sitting on New York and then teleporting, which is what capping at the ends
  // used to do.
  check('...at the midpoint of a short leg with days to spare',
    between.pos.map((n) => Math.round(n * 10) / 10).join(','), '-75.1,38.5')

  // On a leg long enough to sail, it IS partway — and exactly `days x speed` from the far end.
  const longHop = [
    { from: 'Cartagena, Colombia', to: 'New York, NY', coords: [[-75, 10], [-74, 40]],
      start: new Date(2099, 5, 12), end: new Date(2099, 9, 4) },
    { from: 'New York, NY', to: 'Far, XX', coords: [[-74, 40], [-14, 40]],
      start: new Date(2099, 9, 4), end: new Date(2099, 9, 13) },
  ]
  // 10 Oct: six days into a nine-day leg, so past the midpoint and measuring INWARD from the call.
  const sailing = positionOnItinerary(longHop, new Date(2099, 9, 10))
  check('a long second leg puts the ship in transit on it', sailing.index, 1)
  check('...east of New York', sailing.pos[0] > -74, true)
  {
    let km = 0
    const c = sailing.remaining[0]
    for (let i = 0; i < c.length - 1; i += 1) km += haversine(c[i], c[i + 1])
    // 3 days to run. The constant lives in vesselMath; this checks the relationship holds.
    check('...and exactly three days of steaming from the call', Math.abs(km / 3 - 620) < 25, true,
      `implied ${Math.round(km / 3)} km/day`)
  }

  // Past every call, which is reachable while a box is aboard with no arrival reported. Held at
  // the last port rather than extrapolated off the end of the line.
  const after = positionOnItinerary(legs, new Date(2099, 11, 1))
  check('past the last call, held at the final port',
    JSON.stringify(after.pos), JSON.stringify([-76.3, 36.9]))
}

// ── NOT SAILED YET: the origin card ────────────────────────────────────────────────────
//
// A container whose ETD is in the future used to be drawn NOWHERE. `shipmentState` returned
// `future`, the Overview counted it and search found it, but buildHolders dropped it on
// `state !== 'enroute'` — so a booked container was invisible on the map until the day it sailed.
// It now sits at the port it will load from.
console.log('\norigin cards — not sailed yet\n')
{
  const soon = new Date(); soon.setDate(soon.getDate() + 11)
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const notSailed = (over) => ship({ actual_shipping: ymd(soon), ...over })
  const points = new Map([[normalizeKey('Bangkok, Thailand'), [100, 13]]])
  const cards = (rows) => buildHolders(rows, routes, points, rails).ports

  const one = cards([notSailed({ shipment: 'A' })])
  check('a future container gets a card', one.length, 1)
  check('...at its LOAD port, not its discharge port', one[0].name, 'Bangkok, Thailand')
  check('...of its own kind', one[0].kind, 'origin')
  check('...saying so', one[0].subtitle, 'Port of loading')
  check('...anchored on the port point', JSON.stringify(one[0].coordinates), JSON.stringify([100, 13]))

  check('two future boxes from one port share a card',
    cards([notSailed({ shipment: 'A' }), notSailed({ shipment: 'B' })]).length, 1)
  check('...holding both',
    cards([notSailed({ shipment: 'A' }), notSailed({ shipment: 'B' })])[0].containers.length, 2)
  check('different load ports -> different cards',
    cards([notSailed({ shipment: 'A' }),
           notSailed({ shipment: 'B', port_of_loading: 'Cartagena, Colombia',
                       route: 'Cartagena, Colombia - New York, NY' })]).length, 2)

  // AN ORIGIN NEVER MERGES WITH A DISCHARGE CARD, even at the same port. Not today's data — load
  // ports are international and discharge ports are not — but the `origin|` prefix is what stops
  // "waiting to load" and "landed" ever sharing one card and one count.
  const both = cards([
    notSailed({ shipment: 'A', port_of_loading: 'New York, NY', port_of_discharge: 'Los Angeles, CA',
                Lastcy: 'Los Angeles, CA', route: 'Bangkok, Thailand - Los Angeles, CA' }),
    ship({ shipment: 'B', actual_portdate: '2026-06-05' }), // landed at New York
  ])
  check('one port as both origin and destination -> two cards', both.length, 2)
  check('...and they carry different kinds',
    both.map((c) => c.kind).sort().join(','), 'origin,port')

  // The holder key is prefixed; the ANCHOR is not. MapView resolves coordinates through portKey,
  // and looking up the prefixed key would report every load port as unanchored.
  check('portKey is the bare port, not the prefixed key', one[0].portKey, normalizeKey('Bangkok, Thailand'))
  check('...while the holder key is prefixed', one[0].key.startsWith('origin|'), true)

  // A load port with no row in world_ports still draws, on the first vertex of its own sea lane —
  // the mirror of the routeEnd fallback a discharge card uses.
  const unanchored = buildHolders([notSailed({ shipment: 'A' })], routes, new Map(), rails).ports
  check('no port row -> falls back to the lane start',
    JSON.stringify(unanchored[0].coordinates), JSON.stringify([100, 13]))
}

// ── DISTANCE TO PORT TRACKS DAYS TO ARRIVAL ────────────────────────────────────
//
// The map is read by comparing markers: a ship nearer the coast is arriving sooner. That was not
// true. Position used to be the fraction of the ETD -> ETA window elapsed, applied to the fraction
// of the lane covered — so each ship moved at its own implied average, and those averages differ by
// 3x because the window also holds loading, transshipment dwell and berth waiting. Measured on the
// real feed:
//
//     ONE FREEDOM      9 days out   3,847 km to go
//     WAN HAI 507     10 days out   3,671 km to go   <- arrives LATER, drawn CLOSER
//
//     BAY BRIDGE        4 days out   1,382 km to go
//     SEASPAN BRISBANE  4 days out   2,010 km to go   <- same morning, 628 km apart
//
// Neither throws and neither looks wrong on its own; you only see it by comparing two markers and
// knowing their ETAs. So it is pinned here.
console.log('\ndistance tracks days, not schedule padding\n')
{
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(0,0,0,0); return d }
  // Two legs to the same meridian, one twice as long as the other. Degrees of longitude at the
  // equator are equal-length, so the km ratio is exactly the coordinate ratio.
  // Long enough that six days of steaming (3,720 km) is inside half of each leg, so the midpoint cap
  // does not bind and this measures the inbound rule rather than the cap.
  const shortLeg = [{ from: 'A', to: 'Z', coords: [[0, 0], [80, 0]], start: day(-30), end: day(6) }]
  const longLeg  = [{ from: 'B', to: 'Z', coords: [[0, 0], [160, 0]], start: day(-60), end: day(6) }]

  const kmLeft = (legs) => {
    const at = positionOnItinerary(legs)
    return at.remaining.reduce((n, c) => {
      let t = 0
      for (let i = 0; i < c.length - 1; i += 1) t += haversine(c[i], c[i + 1])
      return n + t
    }, 0)
  }

  const a = kmLeft(shortLeg)
  const b = kmLeft(longLeg)
  check('two ships arriving the same day are the same distance out', Math.round(a) === Math.round(b), true,
    `${Math.round(a)} vs ${Math.round(b)} km`)
  // 6 days x 620 km/day. The constant is in vesselMath; this asserts the RELATIONSHIP, and that the
  // figure is a plausible service speed rather than whatever the schedule implied.
  check('...and that distance is days x a service speed', Math.abs(a / 6 - 620) < 25, true,
    `implied ${Math.round(a / 6)} km/day`)

  // The ordering property the map is actually read for.
  const sooner = kmLeft([{ ...shortLeg[0], end: day(4) }])
  const later  = kmLeft([{ ...longLeg[0], end: day(9) }])
  check('a ship arriving sooner is closer, even on a much shorter lane', sooner < later, true,
    `${Math.round(sooner)} km at 4d vs ${Math.round(later)} km at 9d`)

  // SLACK IS HELD MID-ROUTE, which is the point of the halves. A 4,450 km leg with 45 days allotted
  // has far more time than it needs; the ship sails out at service speed, reaches the middle, and
  // waits there for the inbound clock. That is the hub, drawn — not a ship pinned to its load port
  // a fortnight after it sailed.
  const slack = positionOnItinerary([{ from: 'A', to: 'Z', coords: [[0, 0], [40, 0]], start: day(-5), end: day(40) }])
  check('slack holds a ship mid-route, not at its origin',
    JSON.stringify(slack.pos), JSON.stringify([20, 0]))

  // Departed today: at the origin, and only then.
  const justSailed = positionOnItinerary([{ from: 'A', to: 'Z', coords: [[0, 0], [40, 0]], start: day(0), end: day(40) }])
  check('a ship that sailed today IS at its origin', JSON.stringify(justSailed.pos), JSON.stringify([0, 0]))

  // THE HANDOVER MUST NOT JUMP. Computed independently the outbound and inbound rules disagree —
  // measured 7,600 km apart at the crossover on one lane — which is why both cap at half the leg
  // and the speed is at least what the schedule demands. Walking a whole voyage day by day, no
  // single day may move the ship further than one day of steaming.
  const leg = { from: 'A', to: 'Z', coords: [[0, 0], [120, 0]], start: day(-40), end: day(20) }
  let worst = 0
  let prev = null
  for (let d = -40; d <= 20; d += 1) {
    const at = positionOnItinerary([leg], day(d))
    if (prev) worst = Math.max(worst, haversine(prev, at.pos))
    prev = at.pos
  }
  check('no day of the voyage moves the ship more than a day of steaming', worst <= 640, true,
    `worst single-day step ${Math.round(worst)} km`)

  // Overdue: the ETA passed with no arrival reported. At the port is the honest place for it.
  const late = positionOnItinerary([{ from: 'A', to: 'Z', coords: [[0, 0], [40, 0]], start: day(-30), end: day(-3) }])
  check('past its ETA -> at the port', JSON.stringify(late.pos), JSON.stringify([40, 0]))
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
check('across two discharge calls', cautin[0]?.calls.length, 3)
check('New York first, then Norfolk',
  cautin[0]?.calls.filter((c) => c.kind === 'discharge').map((c) => c.name).join(' > '),
  'New York, NY > Norfolk, VA')
check('with geometry for both legs', cautin[0]?.legs.length, 2)

// MSC ANNA names Los Angeles AND Long Beach, which is one gateway and so one call — not a 13.6 km
// leg across its own harbour. (Its containers have all landed, so it draws no vessel; the check is
// on the itinerary the sailing would have.)
const anna = buildHolders(
  shipments.filter((s) => s.vessel === 'MSC ANNA').map((s) => ({ ...s, actual_portdate: '' })),
  realRoutes, new Map(), new Map(),
).vessels
check('MSC ANNA is ONE holder', anna.length, 1)
check('...discharging once, LA and Long Beach folded',
  anna[0]?.calls.filter((c) => c.kind === 'discharge').length, 1)
check('...named for the complex',
  anna[0]?.calls.find((c) => c.kind === 'discharge')?.name, 'Los Angeles, CA')

// BUDAPEST IS MID-LOAD: it sailed from Pipavav three days ago and reaches Nhava Sheva in four, so
// one box is aboard and one is still standing on the quay. Both halves have to be true at once.
//
// NOTE THE ORDER IS NOT FILE ORDER. INBSHIP3971 (Nhava Sheva) is written FIRST in the fixture and
// called SECOND, because the chain is built from the dates. A chain assembled in row order would
// pass on any fixture where the two happen to agree; this one is arranged so it cannot.
const liveCards = buildHolders(shipments, realRoutes, new Map(), new Map()).ports
const budapest = live.find((v) => v.name === 'BUDAPEST')
check('BUDAPEST is on the water', Boolean(budapest), true)
check('...carrying only the box that has loaded', budapest?.containers.length, 1)
check('...which is the PIPAVAV box, the one that has sailed',
  budapest?.containers[0]?.port_of_loading, 'Pipavav, India')
check('...over an itinerary of two loads and a discharge', budapest?.calls.length, 3)
check('...Pipavav, Nhava Sheva, then Los Angeles',
  budapest?.calls.map((c) => c.name).join(' > '),
  'Pipavav, India > Nhava Sheva, India > Los Angeles, CA')
check('...on the leg to Nhava Sheva', budapest?.legs[0]?.to, 'Nhava Sheva, India')
const nhava = liveCards.find((p) => p.name === 'Nhava Sheva, India')
check('...while the box not yet loaded waits at Nhava Sheva', nhava?.kind, 'origin')
check('...on its own card', nhava?.containers.length, 1)
check('...and Pipavav has no card left', liveCards.some((p) => p.name === 'Pipavav, India'), false)

check('no vessel is drawn twice', vesselSplits(live).length, 0)
check('every holder has geometry to ride', live.every((v) => v.legs.length >= 1), true)
check('no holder is missing a leg', live.every((v) => !v.missingLeg), true)

console.log(failed === 0 ? '\nAll grouping checks passed.' : `\n${failed} check(s) FAILED.`)
process.exit(failed === 0 ? 0 : 1)
