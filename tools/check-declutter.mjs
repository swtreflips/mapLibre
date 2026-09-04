// Regression tests for src/map/declutter.js.
//
//   npm run test:declutter
//
// WHY THIS EXISTS. `relaxOverlaps` had no test at all, and it now positions both the port cards and
// the vessel markers. Every way it can fail is silent:
//
//   - Divide by zero on two markers at the SAME coordinate produces NaN, and MapLibre renders a
//     NaN position as a marker that is simply not there. No error, no warning, one fewer ship.
//   - Non-deterministic output makes markers swap places between frames. That reads as jitter, not
//     as a bug, so it gets lived with.
//   - Displacing a marker that overlaps nothing quietly moves it off its true position, which is
//     the one thing this function must never do — the whole justification for pixel-space
//     de-clustering is that offsets vanish once you zoom in far enough to tell markers apart.
//
// The exact-coincidence case is not hypothetical. Placing vessels at `daysLeft x 620 km` from their
// next call put BAY BRIDGE and SEASPAN BRISBANE on the same node to two decimal places, because
// searoute lanes share network edges and both were four days from Los Angeles.

import { relaxOverlaps } from '../src/map/declutter.js'

let failed = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

const at = (x, y) => ({ x, y })
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const moved = (pts, offs) => pts.map((p, i) => at(p.x + offs[i][0], p.y + offs[i][1]))

// ── Nothing that does not overlap is ever moved ──────────────────────────────────────
console.log('markers that clear each other are left alone\n')
{
  const pts = [at(0, 0), at(500, 500)]
  check('two far-apart markers get no offset', relaxOverlaps(pts, [15, 15], 5), [[0, 0], [0, 0]])
  check('a lone marker gets no offset', relaxOverlaps([at(10, 10)], [15], 5), [[0, 0]])
  check('an empty set is fine', relaxOverlaps([], [], 5), [])
  // Exactly touching at the required gap: the boundary must not nudge.
  check('exactly the required gap apart is not an overlap',
    relaxOverlaps([at(0, 0), at(35, 0)], [15, 15], 5), [[0, 0], [0, 0]])
}

// ── The case that was in production ──────────────────────────────────────────────────
console.log('\nexactly coincident markers\n')
{
  const pts = [at(100, 100), at(100, 100)]
  const offs = relaxOverlaps(pts, [15, 15], 5)
  const finite = offs.every(([dx, dy]) => Number.isFinite(dx) && Number.isFinite(dy))
  // The failure this replaces: normalising a zero-length vector yields NaN, and a NaN coordinate
  // is not an error to MapLibre — it is a marker that silently does not draw.
  check('two markers on the SAME point produce finite offsets', finite, true)
  const out = moved(pts, offs)
  check('...and end up at least their radii + gap apart', dist(out[0], out[1]) >= 34.9, true)

  const three = [at(0, 0), at(0, 0), at(0, 0)]
  const o3 = relaxOverlaps(three, [15, 15, 15], 5)
  const m3 = moved(three, o3)
  check('three on one point all separate',
    m3.every((a, i) => m3.every((b, j) => i === j || dist(a, b) >= 34.9)), true)
}

// ── Determinism: the anti-flicker contract ───────────────────────────────────────────
//
// The function's own doc requires callers to pass a stable order. That is only worth anything if
// the same order really does give the same answer — otherwise markers trade places every frame.
console.log('\nthe same input gives the same output\n')
{
  const pts = [at(0, 0), at(10, 0), at(20, 5), at(0, 0)]
  const radii = [15, 15, 15, 15]
  const a = relaxOverlaps(pts, radii, 5)
  const b = relaxOverlaps(pts, radii, 5)
  check('run twice, identical', a, b)
  check('...and the inputs were not mutated', JSON.stringify(pts), JSON.stringify([at(0, 0), at(10, 0), at(20, 5), at(0, 0)]))
}

// ── A cluster stays where it is ──────────────────────────────────────────────────────
//
// Corrections are split between each pair so neither is privileged. Without that the whole group
// drifts toward whichever marker was moved last, which would walk a cluster off its own geography.
console.log('\na cluster does not drift\n')
{
  const pts = [at(100, 100), at(104, 100)]
  const offs = relaxOverlaps(pts, [15, 15], 5)
  const out = moved(pts, offs)
  const before = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
  const after = { x: (out[0].x + out[1].x) / 2, y: (out[0].y + out[1].y) / 2 }
  check('the centre of mass holds', dist(before, after) < 0.001, true)
}

// ── Radii are respected individually ─────────────────────────────────────────────────
//
// Port cards pass a per-marker radius that varies with how many containers a port holds, so the
// required separation is not one constant.
console.log('\nper-marker radii\n')
{
  const pts = [at(0, 0), at(20, 0)]
  const out = moved(pts, relaxOverlaps(pts, [10, 40], 5))
  check('a big marker and a small one clear by the SUM of their radii plus the gap',
    dist(out[0], out[1]) >= 54.9, true)
}

console.log(failed === 0 ? '\nAll declutter checks passed.' : `\n${failed} check(s) FAILED.`)
process.exit(failed === 0 ? 0 : 1)
