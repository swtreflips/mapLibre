// The paint and layout for the three place tiers (src/data/places.js), in one testable place.
//
// WHY THIS IS A MODULE AND NOT INLINE IN MapView. A malformed style expression does not throw where
// you can see it: MapLibre rejects the LAYER and draws nothing, so a mistake here empties the map of
// every label and dot — including the ones that were working. Lint passes, the build passes, the
// unit tests pass, and the map is blank. That happened: nesting a zoom `interpolate` inside a
// `match` is invalid ("Only one zoom-based step or interpolate subexpression may be used"), and it
// took out all 118 places at once.
//
// Exported so `npm run test:style` can run each expression through the real style-spec validator
// rather than trusting that it looks right.
//
// THE ONE RULE THAT MATTERS: a zoom-based `interpolate` must be the OUTERMOST expression. To vary
// something by zoom AND by kind, interpolate on zoom and put the `match` in each STOP VALUE — never
// the other way round.

// Per-kind value at one zoom stop. `ts` is the transshipment tier, `rest` everything else.
const byKind = (ts, rest) => ['match', ['get', 'kind'], 'ts_port', ts, rest]

/**
 * Hollow-ring dots. Transshipment ports get a smaller ring on a flatter curve so they read as
 * background at every zoom they appear at.
 *
 * The non-`ts_port` curve is unchanged from before the third tier existed: 2.5 at z2 rising to 4 at
 * z6, flat above. The z10 stop only exists to carry the transshipment ramp; it repeats 4 for
 * everything else precisely so that curve is not altered.
 */
export const placeDotPaint = (palette) => ({
  'circle-color': palette.dotFill,
  'circle-radius': [
    'interpolate',
    ['linear'],
    ['zoom'],
    2, byKind(2, 2.5),
    6, byKind(2, 4),
    10, byKind(2.8, 4),
  ],
  // No zoom component, so a plain match is legal here.
  'circle-stroke-width': byKind(1, 1.4),
  'circle-stroke-color': [
    'match',
    ['get', 'kind'],
    'ts_port', palette.dotFaint,
    'intl_port', palette.dotIntl,
    palette.dotUs,
  ],
})

/**
 * Place labels.
 *
 * EVERY `match` HERE NEEDS THE THIRD KIND SPELLED OUT. The fallback arm is the US styling — bold,
 * dark — so a kind that does not name itself falls through to the LOUDEST treatment on the map,
 * which is the exact opposite of what a background tier wants.
 *
 * `symbol-sort-key` is `minzoom`, which is what makes the tiers rank themselves: every existing tag
 * sorts <= 4 and every `ts_port` >= 6, so a load port keeps its name in a collision and the
 * transshipment port beside it drops to a bare dot. No priority field to maintain.
 *
 * The non-`ts_port` size curve is unchanged: 11 at z3 rising to 13 at z7, flat above. The z6 stop
 * carries its interpolated value (12.5) exactly so inserting it changes nothing.
 */
export const placeLabelLayout = (fontRegular, fontBold) => ({
  'text-field': ['get', 'name'],
  'text-font': [
    'match',
    ['get', 'kind'],
    'ts_port', ['literal', fontRegular],
    'intl_port', ['literal', fontRegular],
    ['literal', fontBold],
  ],
  'text-size': [
    'interpolate',
    ['linear'],
    ['zoom'],
    3, byKind(9.5, 11),
    6, byKind(9.5, 12.5),
    7, byKind(9.9, 13),
    10, byKind(11, 13),
  ],
  'text-anchor': 'left',
  'text-offset': [0.7, 0],
  'text-letter-spacing': 0.01,
  'text-padding': 4,
  // Let a crowded coast drop names instead of stacking them.
  'text-allow-overlap': false,
  'text-optional': true,
  'symbol-sort-key': ['get', 'minzoom'],
})

export const placeLabelPaint = (palette) => ({
  'text-color': [
    'match',
    ['get', 'kind'],
    'ts_port', palette.labelFaint,
    'intl_port', palette.labelIntl,
    palette.labelUs,
  ],
  'text-halo-color': palette.labelHalo,
  'text-halo-width': 1.4,
  'text-halo-blur': 0.2,
})
