// Regression test for sortByPriority — the order of a PORT tray and of SEARCH RESULTS.
//
//   npm run test:order
//
// WHY THIS EXISTS. A list of containers is a worklist, not a manifest, and the order answers "what
// do I deal with next". Five bands: red, blue, green (at a yard), then everything in motion by
// soonest arrival, then what has not sailed. Within a yard band the longest-sitting box comes
// first — both the most expensive and the most likely to have been forgotten.
//
// ONE FUNCTION SERVES BOTH PANELS on purpose: a container has one place in the queue, and it must
// not depend on which panel you found it through. A port tray only ever shows the first three
// bands, so the moving and future bands are exercised only through search — and only here.
//
// THE BAND ORDER IS THE TRAP. containerStatus returns tone `blue` for an en-route or on-rail
// container too, so ranking on tone alone files every ship under "blue containers at a yard". That
// is invisible in a port tray, where everything is arrived, and wrong the moment a search returns a
// mixed list. The band comes from shipmentState first, and only then the tone.
//
// AND A WRONG ORDER IS INVISIBLE. Every row still shows the right container with the right chip and
// the right dwell; only their sequence is wrong, so the panel looks entirely correct while quietly
// burying the box someone should be dealing with. There is nothing to notice, which is exactly why
// this is asserted rather than eyeballed.
//
// The dwell rule is the subtle half. daysAtCY measures from the facility the box is ACTUALLY in, so
// an intermodal container counts from the day it reached its inland yard — not from the day it
// cleared the seaport, possibly months earlier. Sorting on the wrong one puts a box that arrived
// two days ago at the top of the list (CLAUDE.md §7).

import { pathToFileURL } from 'url'

const ROOT = pathToFileURL(process.cwd() + '/').href
const { sortByPriority, containerStatus, daysAtCY, shipmentState, normalizeKey, currentFacility, canonicalPort } =
  await import(new URL('src/lib/vesselMath.js', ROOT).href)

const TODAY = new Date(2026, 7, 30) // 2026-08-30, local midnight

let failed = 0
const check = (name, got, want) => {
  const ok = got === want
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got ${got}\n       want ${want}`}`)
}

// An arrived container at a port. `appt` makes it green; dwell decides red vs blue (> 3 days red).
const box = (shipment, portdate, appt = '') => ({
  shipment,
  container: shipment,
  vessel: 'SHIP',
  port_of_loading: 'Bangkok, Thailand',
  port_of_discharge: 'New York, NY',
  Lastcy: 'New York, NY',
  route: 'Bangkok, Thailand - New York, NY',
  actual_shipping: '2026-01-01',
  expected_portdate: portdate,
  actual_portdate: portdate,
  appointment_date: appt,
  arrival_notice: 'yes',
  last_freeday: '',
  items: [],
})

const order = (rows) => sortByPriority(rows, TODAY).map((s) => s.shipment).join(' ')

// Sanity: the fixtures really are the colours the test assumes.
console.log('the fixtures are the colours this test assumes\n')
for (const [s, tone] of [
  [box('r', '2026-08-20'), 'red'],
  [box('b', '2026-08-28'), 'blue'],
  [box('g', '2026-08-20', '2026-09-02'), 'green'],
]) {
  check(`${s.shipment} -> ${tone} (${daysAtCY(s, TODAY)}d)`, containerStatus(s, TODAY).tone, tone)
}

console.log('\ncolour bands, in priority order\n')
// Deliberately fed in the WRONG order each time, so a function that returned its input unchanged
// would fail rather than accidentally pass.
check(
  'red before blue before green',
  order([
    box('GREEN', '2026-08-01', '2026-09-02'),
    box('BLUE', '2026-08-28'),
    box('RED', '2026-08-10'),
  ]),
  'RED BLUE GREEN',
)
check(
  'green sinks even when it has sat longest',
  order([box('GREEN-90D', '2026-06-01', '2026-09-02'), box('RED-10D', '2026-08-20')]),
  'RED-10D GREEN-90D',
)
check(
  'blue outranks green regardless of dwell',
  order([box('GREEN-90D', '2026-06-01', '2026-09-02'), box('BLUE-0D', '2026-08-30')]),
  'BLUE-0D GREEN-90D',
)

console.log('\nlongest dwell first, within each colour\n')
check(
  'red: 40d, 10d, 4d',
  order([box('R-4', '2026-08-26'), box('R-40', '2026-07-21'), box('R-10', '2026-08-20')]),
  'R-40 R-10 R-4',
)
check(
  'blue: 3d, 1d, landed today',
  order([box('B-0', '2026-08-30'), box('B-3', '2026-08-27'), box('B-1', '2026-08-29')]),
  'B-3 B-1 B-0',
)
check(
  'green: same rule applies inside the band',
  order([
    box('G-2', '2026-08-28', '2026-09-02'),
    box('G-60', '2026-07-01', '2026-09-02'),
    box('G-20', '2026-08-10', '2026-09-02'),
  ]),
  'G-60 G-20 G-2',
)

console.log('\nthe 3-day boundary between blue and red\n')
check('exactly 3 days is BLUE', containerStatus(box('x', '2026-08-27'), TODAY).tone, 'blue')
check('4 days is RED', containerStatus(box('x', '2026-08-26'), TODAY).tone, 'red')
check(
  'so a 4-day red outranks a 3-day blue',
  order([box('BLUE-3D', '2026-08-27'), box('RED-4D', '2026-08-26')]),
  'RED-4D BLUE-3D',
)

console.log('\nstability\n')
check(
  'same colour, same dwell -> shipment id decides',
  order([box('C', '2026-08-20'), box('A', '2026-08-20'), box('B', '2026-08-20')]),
  'A B C',
)
// Two runs over a shuffled input must agree, or rows jump between refreshes.
const pool = [
  box('D', '2026-08-20'), box('A', '2026-08-20'), box('E', '2026-08-28'),
  box('B', '2026-08-01', '2026-09-02'), box('C', '2026-08-29'),
]
check('re-sorting a sorted list is a no-op', order(sortByPriority(pool, TODAY)), order(pool))

console.log('\nit does not mutate the caller\n')
// The holder object is SHARED WITH THE MAP. An in-place sort here would reach past the panel that
// asked for it and re-order the array the port card reads.
const original = [box('Z', '2026-08-28'), box('Y', '2026-08-01')]
const before = original.map((s) => s.shipment).join(' ')
sortByPriority(original, TODAY)
check('input array untouched', original.map((s) => s.shipment).join(' '), before)
check('returns a different array', sortByPriority(original, TODAY) === original, false)

console.log('\ndegenerate input\n')
check('empty array', sortByPriority([], TODAY).length, 0)
check('null', sortByPriority(null, TODAY).length, 0)
check('undefined', sortByPriority(undefined, TODAY).length, 0)
check('single container', order([box('ONE', '2026-08-20')]), 'ONE')

console.log('\ndwell is measured at the facility the box is IN\n')
// Intermodal: cleared Los Angeles on 1 June, reached its Denver yard on 28 August. It has been at
// Denver for 2 days, so it is BLUE. Measured from actual_portdate it would read 90 days and sort to
// the top of the red band — above containers genuinely aging.
const inland = {
  ...box('INLAND', '2026-06-01'),
  port_of_discharge: 'Los Angeles, CA',
  Lastcy: 'Denver, CO',
  sea_route: 'Bangkok, Thailand - Los Angeles, CA',
  rail_route: 'Los Angeles, CA - Denver, CO',
  expected_lastcy_date: '2026-08-28',
}
check('counts from the inland yard, not the seaport', daysAtCY(inland, TODAY), 2)
check('so it is blue, not red', containerStatus(inland, TODAY).tone, 'blue')
check(
  'and it sorts below a genuinely aging box',
  order([inland, box('RED-10D', '2026-08-20')]),
  'RED-10D INLAND',
)

// ── Mixed states: what a SEARCH returns ────────────────────────────────────────────────
//
// A port tray holds only arrived containers, so bands 3 and 4 exist solely for search results.
console.log('\nmixed states — the search-result bands\n')

// A container still on the water. `enroute` = sailed, not yet arrived.
const sailing = (shipment, eta, etd = '2026-01-01') => ({
  ...box(shipment, eta),
  actual_shipping: etd,
  expected_portdate: eta,
  actual_portdate: '',
})

// Not sailed yet: ETD in the future.
const notSailed = (shipment, etd) => ({
  ...box(shipment, '2099-01-01'),
  actual_shipping: etd,
  expected_portdate: '2099-01-01',
  actual_portdate: '',
})

// On a train: landed at the port, inland yard date still ahead.
const onRail = (shipment, cyDate) => ({
  ...box(shipment, '2026-08-01'),
  port_of_discharge: 'Los Angeles, CA',
  Lastcy: 'Denver, CO',
  sea_route: 'Bangkok, Thailand - Los Angeles, CA',
  rail_route: 'Los Angeles, CA - Denver, CO',
  actual_portdate: '2026-08-01',
  expected_lastcy_date: cyDate,
})

// The states really are what the cases below assume.
check('sailing box is enroute', shipmentState(sailing('x', '2026-09-10'), TODAY), 'enroute')
check('rail box is rail', shipmentState(onRail('x', '2026-09-05'), TODAY), 'rail')
check('unsailed box is future', shipmentState(notSailed('x', '2026-09-20'), TODAY), 'future')

check(
  'yard containers come before anything moving',
  order([sailing('SAILING', '2026-09-10'), box('GREEN', '2026-08-01', '2026-09-02'), box('RED', '2026-08-10')]),
  'RED GREEN SAILING',
)
check(
  'even a GREEN yard box outranks a ship arriving tomorrow',
  order([sailing('SHIP-1D', '2026-08-31'), box('GREEN', '2026-08-01', '2026-09-02')]),
  'GREEN SHIP-1D',
)
check(
  'ships sort SOONEST ARRIVAL first',
  order([sailing('DEC', '2026-12-01'), sailing('SEP', '2026-09-02'), sailing('OCT', '2026-10-15')]),
  'SEP OCT DEC',
)

// Rail and sea share one band, ranked on the one axis that matters: when the box lands.
check(
  'a train arriving sooner outranks a ship arriving later',
  order([sailing('SHIP-DEC', '2026-12-01'), onRail('RAIL-SEP', '2026-09-03')]),
  'RAIL-SEP SHIP-DEC',
)
check(
  'and a ship arriving sooner outranks a train arriving later',
  order([onRail('RAIL-DEC', '2026-12-01'), sailing('SHIP-SEP', '2026-09-03')]),
  'SHIP-SEP RAIL-DEC',
)

check(
  'not-sailed sorts LAST, however soon it is due',
  order([notSailed('FUTURE-TOMORROW', '2026-08-31'), sailing('SHIP-DEC', '2026-12-01')]),
  'SHIP-DEC FUTURE-TOMORROW',
)
check(
  'and within future, soonest departure first',
  order([notSailed('F-NOV', '2026-11-01'), notSailed('F-SEP', '2026-09-05')]),
  'F-SEP F-NOV',
)

check(
  'all five bands at once',
  order([
    notSailed('5-FUTURE', '2026-09-20'),
    sailing('4-SHIP', '2026-10-01'),
    box('3-GREEN', '2026-08-01', '2026-09-02'),
    box('2-BLUE', '2026-08-28'),
    box('1-RED', '2026-08-10'),
  ]),
  '1-RED 2-BLUE 3-GREEN 4-SHIP 5-FUTURE',
)

// A blank date is not an imminent arrival. It sorts to the bottom of its band, not the top.
check(
  'a mover with no ETA sinks within its band',
  order([{ ...sailing('NO-ETA', '2026-09-10'), expected_portdate: '' }, sailing('HAS-ETA', '2026-12-01')]),
  'HAS-ETA NO-ETA',
)

// ── The port tray is UNCHANGED by any of the above ─────────────────────────────────────
//
// Everything a port holds is `arrived`, so it lands in bands 0-2 and the extra bands never apply.
// This is the regression that matters: widening the function for search must not reorder a tray.
console.log('\nport trays are unaffected by the new bands\n')
check(
  'red, blue, green — exactly as before',
  order([box('G', '2026-08-01', '2026-09-02'), box('B', '2026-08-28'), box('R', '2026-08-10')]),
  'R B G',
)
check(
  'dwell order inside a band — exactly as before',
  order([box('R-4', '2026-08-26'), box('R-40', '2026-07-21'), box('R-10', '2026-08-20')]),
  'R-40 R-10 R-4',
)

// ── The live fixture ───────────────────────────────────────────────────────────────────
console.log('\nthe live fixture, as the tray will render it\n')
const { default: shipments } = await import(new URL('src/data/inboundShipments.js', ROOT).href)
const byPort = new Map()
for (const s of shipments) {
  if (shipmentState(s) !== 'arrived') continue
  const name = canonicalPort(currentFacility(s))
  if (!byPort.has(normalizeKey(name))) byPort.set(normalizeKey(name), { name, rows: [] })
  byPort.get(normalizeKey(name)).rows.push(s)
}
let liveOk = true
for (const { name, rows } of byPort.values()) {
  const sorted = sortByPriority(rows)
  console.log(`      ${name}`)
  for (const s of sorted) {
    const st = containerStatus(s)
    console.log(`        ${st.tone.padEnd(5)} ${String(daysAtCY(s) ?? 0).padStart(3)}d  ${s.shipment}  ${st.label}`)
  }
  // Assert the invariant on the real data rather than on the printed list.
  const ranks = sorted.map((s) => ({ red: 0, blue: 1, green: 2 })[containerStatus(s).tone])
  const days = sorted.map((s) => daysAtCY(s) ?? 0)
  for (let i = 1; i < sorted.length; i++) {
    if (ranks[i] < ranks[i - 1]) liveOk = false
    if (ranks[i] === ranks[i - 1] && days[i] > days[i - 1]) liveOk = false
  }
}
check('every live port tray is in priority order', liveOk, true)

console.log(failed === 0 ? '\nAll tray-order checks passed.' : `\n${failed} check(s) FAILED.`)
process.exit(failed === 0 ? 0 : 1)
