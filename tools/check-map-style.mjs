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

// A stand-in palette: only the shape matters, and every value must be a real colour or the colour
// properties fail for the wrong reason.
const palette = {
  dotFill: '#ffffff', dotFaint: '#80868b', dotIntl: '#5f6368', dotUs: 'rgb(173 85 42)',
  labelFaint: '#80868b', labelIntl: '#5f6368', labelUs: '#3c4043', labelHalo: '#ffffff',
}
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

console.log(failed === 0 ? '\nAll style checks passed.' : `\n${failed} check(s) FAILED.`)
process.exit(failed === 0 ? 0 : 1)
