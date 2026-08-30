// Regression test for voyagePhase() / formatDay() — the tray header's voyage line.
//
//   npm run test:voyage
//
// WHY THIS EXISTS. The live fixture cannot exercise this function. On the day it was written both
// en-route vessels sat PAST the halfway mark (CAUTIN 72.8%, WAN HAI 272 at 100%), so clicking
// around the running app demonstrates exactly one of the three branches. The `departed` branch had
// no data at all, and `overdue` was a day away from existing.
//
// The branch worth guarding is the ORDERING. computeProgress clamps to 1, so the fraction cannot
// distinguish "arrives today" from "three weeks late" — only the raw day delta can, which is why
// overdue is tested before the fraction gets a say. Get that backwards and the panel quietly
// renders "ARRIVING IN -1 DAYS" the first day an ETA slips. That is not a loud failure: it is a
// confident sentence, in the right place, about a container that needs attention.

import { voyagePhase, formatDay } from '../src/lib/vesselMath.js'

const d = (s) => {
  const [y, m, day] = s.split('-').map(Number)
  return new Date(y, m - 1, day)
}

const TODAY = d('2026-08-30')

const CASES = [
  // ── departed: under half elapsed ───────────────────────────────────────────────────
  { name: 'sailed today (0%)', etd: '2026-08-30', eta: '2026-09-29', phase: 'departed', label: 'DEPARTED TODAY' },
  { name: 'one day out — SINGULAR', etd: '2026-08-29', eta: '2026-09-29', phase: 'departed', label: 'DEPARTED 1 DAY AGO' },
  { name: 'a quarter of the way', etd: '2026-08-20', eta: '2026-10-09', phase: 'departed', label: 'DEPARTED 10 DAYS AGO' },
  { name: 'just under half (49.5%)', etd: '2026-07-31', eta: '2026-10-01', phase: 'departed', label: 'DEPARTED 30 DAYS AGO' },

  // ── the boundary: exactly 0.5 counts as arriving ───────────────────────────────────
  { name: 'exactly half — tips to arriving', etd: '2026-07-31', eta: '2026-09-29', phase: 'arriving', label: 'ARRIVING IN 30 DAYS' },

  // ── arriving: at or over half, ETA still ahead ─────────────────────────────────────
  { name: 'CAUTIN, the live voyage', etd: '2026-06-08', eta: '2026-09-30', phase: 'arriving', label: 'ARRIVING IN 31 DAYS' },
  { name: 'lands tomorrow — SINGULAR', etd: '2026-08-01', eta: '2026-08-31', phase: 'arriving', label: 'ARRIVING IN 1 DAY' },
  { name: 'WAN HAI 272 — ETA is today', etd: '2026-03-24', eta: '2026-08-30', phase: 'arriving', label: 'ARRIVING TODAY' },

  // ── overdue: the branch the fraction CANNOT express ────────────────────────────────
  //
  // Both of these sit at progress 1.0, identically, which is the entire argument for testing the
  // day delta first. The third case is WAN HAI 272 one day later — the fixture's own voyage,
  // proving the flip rather than asserting it about a made-up one.
  { name: 'one day late — SINGULAR', etd: '2026-08-01', eta: '2026-08-29', phase: 'overdue', label: '1 DAY PAST ETA' },
  { name: 'a month late', etd: '2026-06-01', eta: '2026-07-30', phase: 'overdue', label: '31 DAYS PAST ETA' },
  { name: 'WAN HAI 272, tomorrow', etd: '2026-03-24', eta: '2026-08-30', today: '2026-08-31', phase: 'overdue', label: '1 DAY PAST ETA' },

  // ── degenerate input ──────────────────────────────────────────────────────────────
  //
  // null, NOT a sentence. computeProgress returns 0 for a missing date, so without the guard these
  // render "DEPARTED NaN DAYS AGO" — confident, well-formatted, and meaningless.
  { name: 'no ETD', etd: null, eta: '2026-09-30', expect: null },
  { name: 'no ETA', etd: '2026-06-08', eta: null, expect: null },
  { name: 'neither', etd: null, eta: null, expect: null },
  // computeProgress returns 1 when end <= start, so this lands in overdue via the day delta.
  { name: 'ETA before ETD (bad data)', etd: '2026-09-30', eta: '2026-06-08', phase: 'overdue', label: '83 DAYS PAST ETA' },
  { name: 'ETA equals ETD, both today', etd: '2026-08-30', eta: '2026-08-30', phase: 'arriving', label: 'ARRIVING TODAY' },
]

// formatDay: the year appears only when it is not the current one. A bare "15 Jan" read on
// 30 Aug 2026 means LAST January — the date would say the opposite of what it means.
const DATE_CASES = [
  { name: 'this year — no year shown', date: '2026-09-30', expect: '30 Sep' },
  { name: 'this year, single digit day', date: '2026-09-01', expect: '1 Sep' },
  { name: 'NEXT year — year required', date: '2027-01-15', expect: '15 Jan 2027' },
  { name: 'last year — year required', date: '2025-12-20', expect: '20 Dec 2025' },
  { name: 'null date', date: null, expect: '' },
]

let failed = 0
const check = (name, got, want) => {
  const ok = got === want
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}\n        got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`)
}

console.log('voyagePhase — today 2026-08-30 unless stated\n')
for (const c of CASES) {
  const today = c.today ? d(c.today) : TODAY
  const got = voyagePhase(c.etd && d(c.etd), c.eta && d(c.eta), today)
  if (c.expect === null) {
    check(c.name, got, null)
    continue
  }
  check(c.name, got && `${got.phase} | ${got.label}`, `${c.phase} | ${c.label}`)
}

console.log('\nformatDay — today 2026-08-30\n')
for (const c of DATE_CASES) check(c.name, formatDay(c.date && d(c.date), TODAY), c.expect)

// The header and the map must agree. voyagePhase returns the SAME fraction MapView feeds to
// positionAtProgress, so a sentence saying "arriving in 31 days" can never sit over a ship drawn a
// quarter of the way across the ocean. Asserting it here is what keeps the reuse honest if someone
// later "simplifies" voyagePhase into its own arithmetic.
console.log('\nprogress agrees with computeProgress\n')
const { computeProgress } = await import('../src/lib/vesselMath.js')
for (const c of CASES) {
  if (!c.etd || !c.eta) continue
  const today = c.today ? d(c.today) : TODAY
  const v = voyagePhase(d(c.etd), d(c.eta), today)
  check(`same fraction — ${c.name}`, v.progress, computeProgress(d(c.etd), d(c.eta), today))
}

console.log(failed === 0 ? '\nAll voyage-phase checks passed.' : `\n${failed} check(s) FAILED.`)
process.exit(failed === 0 ? 0 : 1)
