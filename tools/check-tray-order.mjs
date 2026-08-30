// Regression test for sortByPriority — the order of a PORT tray.
//
//   npm run test:order
//
// WHY THIS EXISTS. A port tray is a worklist, not a manifest: everything in it has stopped moving,
// and the order is the answer to "what do I clear next". Red first, then blue, then green, and
// within each colour the longest-sitting box first — the one that is both most expensive and most
// likely to have been forgotten.
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
const { sortByPriority, containerStatus, daysAtCY } = await import(
  new URL('src/lib/vesselMath.js', ROOT).href
)

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

// ── The live fixture ───────────────────────────────────────────────────────────────────
console.log('\nthe live fixture, as the tray will render it\n')
const { default: shipments } = await import(new URL('src/data/inboundShipments.js', ROOT).href)
const { normalizeKey, shipmentState, currentFacility, canonicalPort } = await import(
  new URL('src/lib/vesselMath.js', ROOT).href
)
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
