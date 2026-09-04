// Validates the place-layer style expressions against the real MapLibre style spec.
//
//   npm run test:style
//
// WHY THIS EXISTS. A malformed style expression is the quietest failure in this codebase. It does
// not throw where anyone can see it: MapLibre rejects the LAYER and draws nothing. Lint passes, the
// build passes, every other test passes, and the map is blank.
//
// That is not hypothetical. Adding the transshipment tier nested a zoom `interpolate` inside a
// `match`, which the spec forbids — "Only one zoom-based step or interpolate subexpression may be
// used in an expression" — and it took out ALL 118 places at once, including the ones that had
// worked for months. Nothing in the toolchain noticed.
//
// THE RULE THAT BROKE IT: a zoom-based `interpolate` must be the OUTERMOST expression. To vary
// something by zoom AND by feature, interpolate on zoom and put the `match` in each STOP VALUE.
// The cases at the bottom pin that down in both directions so the lesson survives.

import { createPropertyExpression } from '@maplibre/maplibre-gl-style-spec'
import { placeDotPaint, placeLabelLayout, placeLabelPaint } from '../src/map/placeStyle.js'

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        ${detail}`}`)
}

// Property definitions matching the spec entries for the layers we build.
const NUMBER = { type: 'number', 'property-type': 'data-driven', expression: { interpolated: true, parameters: ['zoom', 'feature'] } }
const COLOR = { type: 'color', 'property-type': 'data-driven', expression: { interpolated: true, parameters: ['zoom', 'feature'] } }
const STRING = { type: 'string', 'property-type': 'data-driven', expression: { interpolated: false, parameters: ['zoom', 'feature'] } }
const FONT = { type: 'array', value: 'string', 'property-type': 'data-driven', expression: { interpolated: false, parameters: ['zoom', 'feature'] } }
const ENUM = { type: 'enum', values: { left: {}, right: {}, center: {}, top: {}, bottom: {} }, 'property-type': 'data-driven', expression: { interpolated: false, parameters: ['zoom', 'feature'] } }
const PADDING = { type: 'array', value: 'number', 'property-type': 'data-driven', expression: { interpolated: true, parameters: ['zoom', 'feature'] } }

const SPEC = {
  'circle-color': COLOR, 'circle-radius': NUMBER, 'circle-stroke-width': NUMBER,
  'circle-stroke-color': COLOR,
  'text-field': STRING, 'text-font': FONT, 'text-size': NUMBER, 'text-anchor': ENUM,
  'text-offset': PADDING, 'text-letter-spacing': NUMBER, 'text-padding': NUMBER,
  'text-allow-overlap': { type: 'boolean', 'property-type': 'data-constant', expression: { interpolated: false, parameters: ['zoom'] } },
  'text-optional': { type: 'boolean', 'property-type': 'data-constant', expression: { interpolated: false, parameters: ['zoom'] } },
  'symbol-sort-key': NUMBER,
  'text-color': COLOR, 'text-halo-color': COLOR, 'text-halo-width': NUMBER, 'text-halo-blur': NUMBER,
}

// Colours come from the REAL palette, not stand-ins: the contrast checks at the bottom are
// meaningless against invented values, and a token edited in basemapStyle.js has to reach this
// test. `skinRgb` falls back to its literal when there is no DOM, which is why this works in node.
const { mapPalette } = await import('../src/map/basemapStyle.js')
const palette = mapPalette()
const FONT_REGULAR = ['Noto Sans Regular']
const FONT_BOLD = ['Noto Sans Bold']

console.log('place layer expressions\n')
for (const [layer, props] of [
  ['place-dots paint', placeDotPaint(palette)],
  ['place-labels layout', placeLabelLayout(FONT_REGULAR, FONT_BOLD)],
  ['place-labels paint', placeLabelPaint(palette)],
]) {
  for (const [prop, value] of Object.entries(props)) {
    const def = SPEC[prop]
    if (!def) { check(`${layer} · ${prop}`, false, 'no spec entry in this test — add one'); continue }
    // A CONSTANT IS NOT AN EXPRESSION. `text-offset: [0.7, 0]` is a literal array, and handing it to
    // the expression parser reads 0.7 as an operator name. Only values whose first element is a
    // string are expression calls; everything else is a plain style value the spec accepts as-is.
    if (!Array.isArray(value) || typeof value[0] !== 'string') {
      check(`${layer} · ${prop} (constant)`, true)
      continue
    }
    const r = createPropertyExpression(value, def)
    check(`${layer} · ${prop}`, r.result === 'success',
      r.result === 'success' ? '' : r.value.map((e) => e.message).join('\n        '))
  }
}

// ── The specific mistake, both ways round ────────────────────────────────────────────
console.log('\nthe zoom-nesting rule\n')
{
  const nested = ['match', ['get', 'kind'],
    'ts_port', ['interpolate', ['linear'], ['zoom'], 6, 9.5, 10, 11],
    ['interpolate', ['linear'], ['zoom'], 3, 11, 7, 13]]
  const r = createPropertyExpression(nested, NUMBER)
  check('a zoom interpolate nested inside a match is REJECTED', r.result === 'error',
    'the spec accepted it — this test no longer guards anything')

  const correct = ['interpolate', ['linear'], ['zoom'],
    3, ['match', ['get', 'kind'], 'ts_port', 9.5, 11],
    7, ['match', ['get', 'kind'], 'ts_port', 9.9, 13]]
  const r2 = createPropertyExpression(correct, NUMBER)
  check('...and interpolate-outside with match in the stops is accepted', r2.result === 'success',
    r2.result === 'success' ? '' : r2.value.map((e) => e.message).join('\n        '))
}

// ── Priority must not be read off the visibility band ────────────────────────────────
//
// `symbol-sort-key` was `minzoom` while the tiers occupied different bands, and that ranked them
// for free. Transshipment ports now share a band with the smaller US seaports, so the two numbers
// had to come apart: a tie on `minzoom` is broken arbitrarily by MapLibre, which would sometimes
// drop the port the work is actually about in favour of one a box merely passes through.
console.log('\nsort key is independent of the band\n')
{
  const layout = placeLabelLayout(FONT_REGULAR, FONT_BOLD)
  check("symbol-sort-key reads 'sort', not 'minzoom'",
    JSON.stringify(layout['symbol-sort-key']) === JSON.stringify(['get', 'sort']),
    `got ${JSON.stringify(layout['symbol-sort-key'])}`)
}

// ── Every kind must be named where the fallback is the loud one ──────────────────────
//
// `text-font`, `text-size` and `text-color` all fall through to the US styling — bold and dark. A
// tier that forgets to name itself gets the most prominent treatment on the map, which is silent
// and exactly backwards.
console.log('\nevery tier is named in the loud-fallback expressions\n')
{
  const layout = placeLabelLayout(FONT_REGULAR, FONT_BOLD)
  const paint = placeLabelPaint(palette)
  const mentions = (expr) => JSON.stringify(expr).includes('ts_port')
  check('text-font names ts_port', mentions(layout['text-font']))
  check('text-size names ts_port', mentions(layout['text-size']))
  check('text-color names ts_port', mentions(paint['text-color']))
  check('circle-stroke-color names ts_port', mentions(placeDotPaint(palette)['circle-stroke-color']))
}

// ── The label tiers must stay ordered AND stay legible ───────────────────────────────
//
// Two things can go wrong independently and neither surfaces as an error. Reorder the greys and the
// hierarchy inverts silently. Lighten the faintest one and the SMALLEST text on the map (9.5px)
// stops being readable — the first attempt at this tier used Google's tertiary #80868b, which
// measures 3.21 against the land and 3.68 against its halo, both under the 4.5 WCAG AA wants.
const luminance = (hex) => {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const [r, g, b] = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

console.log('\nlabel tiers: ordered and legible\n')
{
  // Measured against the HALO, because that is what the glyphs actually sit on.
  const HALO = '#ffffff'
  const us = contrast(palette.labelUs, HALO)
  const intl = contrast(palette.labelIntl, HALO)
  const faint = contrast(palette.labelFaint, HALO)
  check(
    `hierarchy holds: us ${us.toFixed(2)} > intl ${intl.toFixed(2)} > faint ${faint.toFixed(2)}`,
    us > intl && intl > faint,
  )
  check(`faintest tier clears AA on its halo (${faint.toFixed(2)} >= 4.5)`, faint >= 4.5,
    `${palette.labelFaint} is too light for 9.5px text`)
}

console.log(failed === 0 ? '\nAll style checks passed.' : `\n${failed} check(s) FAILED.`)
process.exit(failed === 0 ? 0 : 1)
