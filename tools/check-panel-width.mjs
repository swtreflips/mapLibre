// Regression tests for the sidebar width in src/lib/panelWidth.js.
//
//   npm run test:panel
//
// WHY THIS EXISTS. Both halves of this module fail QUIETLY.
//
// A bad width does not throw. `Math.min(Math.max(NaN, …))` is NaN, and a NaN reaches CSS as an
// invalid value — which is not an error, it is simply ignored, leaving the panel at whatever the
// stylesheet last said or at nothing at all. A stored string, a corrupted entry, or an arithmetic
// slip mid-drag all arrive at `clampWidth`, and all of them have to come out as a usable number.
//
// And `localStorage` throws in ordinary use, not exotic use: a private window can deny access
// outright and a full quota rejects the write. A panel preference that takes the dashboard down
// with it is far worse than one that forgets, so every path here has to degrade rather than raise.
// src/lib/notes.js documents the same hazard; this is the same stance applied to one number.

import { readFileSync } from 'fs'

const src = readFileSync('src/lib/panelWidth.js', 'utf8')
const load = () => import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
let { MIN_WIDTH, MAX_WIDTH, TWO_COL_AT, clampWidth, readWidth, writeWidth } = await load()

let failed = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

// ── The stops ────────────────────────────────────────────────────────────────────────
console.log('clamping\n')
check('below the minimum is held at it', clampWidth(379), MIN_WIDTH)
check('far below', clampWidth(-2000), MIN_WIDTH)
check('above the maximum is held at it', clampWidth(761), MAX_WIDTH)
check('far above', clampWidth(99999), MAX_WIDTH)
check('the minimum itself is untouched', clampWidth(MIN_WIDTH), MIN_WIDTH)
check('the maximum itself is untouched', clampWidth(MAX_WIDTH), MAX_WIDTH)
check('a width in range is untouched', clampWidth(520), 520)
check('fractions round, so CSS gets a whole pixel', clampWidth(520.6), 521)

// ── A bad value must not become a bad WIDTH ──────────────────────────────────────────
//
// This is the case that motivated the module. NaN is not a number CSS rejects loudly; it is a
// declaration the browser drops, and the panel silently keeps or loses its width.
console.log('\nnothing produces NaN\n')
for (const bad of [NaN, undefined, null, '', 'wide', {}, [], Infinity, -Infinity]) {
  const got = clampWidth(bad)
  check(`clampWidth(${JSON.stringify(bad) ?? String(bad)}) -> the minimum`, got, MIN_WIDTH)
}
check('a numeric STRING is still honoured', clampWidth('520'), 520)

// ── The threshold has to stay between the stops, and stay usable ─────────────────────
//
// Lowering TWO_COL_AT is the tempting change — two columns sooner feels like more feature. These
// assert the point past which it stops being one: the cards get too narrow to read.
console.log('\nthe two-column threshold\n')
check('sits strictly between the stops', TWO_COL_AT > MIN_WIDTH && TWO_COL_AT < MAX_WIDTH, true)
{
  // Matches .tray__list in Sidebar.css: 12px padding either side, 10px gap between the columns.
  const colAt = (panel) => (panel - 24 - 10) / 2
  const atThreshold = colAt(TWO_COL_AT)
  const atMax = colAt(MAX_WIDTH)
  const single = MIN_WIDTH - 24
  console.log(`      one column today ${single}px · two columns at the threshold ${atThreshold}px · at the stop ${atMax}px`)
  check('columns at the threshold are wide enough to read (>= 280px)', atThreshold >= 280, true)
  check('and at the stop they beat the single column of today', atMax > single, true)
}

// ── Storage degrades, never throws ───────────────────────────────────────────────────
console.log('\nlocalStorage guards\n')
{
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  }
  check('nothing stored -> the minimum', readWidth(), MIN_WIDTH)
  check('a write reports success', writeWidth(520), true)
  check('...and reads back', readWidth(), 520)
  check('a stored OUT-OF-RANGE value is clamped on read', (store.set('inbound.sidebar.v1', '5000'), readWidth()), MAX_WIDTH)
  check('a stored GARBAGE value falls back', (store.set('inbound.sidebar.v1', 'wide'), readWidth()), MIN_WIDTH)
  check('a width is stored clamped, not raw', (writeWidth(9999), store.get('inbound.sidebar.v1')), String(MAX_WIDTH))
}
{
  // The private-window case: the property access itself raises.
  globalThis.localStorage = {
    getItem() { throw new Error('SecurityError: access denied') },
    setItem() { throw new Error('QuotaExceededError') },
  }
  let threw = false
  let got
  try { got = readWidth() } catch { threw = true }
  check('a throwing read does not propagate', threw, false)
  check('...and returns the default', got, MIN_WIDTH)

  threw = false
  let wrote
  try { wrote = writeWidth(520) } catch { threw = true }
  check('a throwing write does not propagate', threw, false)
  check('...and reports failure rather than pretending', wrote, false)
}
{
  // No storage at all — server render, or a locked-down embed.
  delete globalThis.localStorage
  check('no localStorage object at all -> the default', readWidth(), MIN_WIDTH)
  check('...and a write simply reports false', writeWidth(520), false)
}

console.log(failed === 0 ? '\nAll panel-width checks passed.' : `\n${failed} check(s) FAILED.`)
process.exit(failed === 0 ? 0 : 1)
