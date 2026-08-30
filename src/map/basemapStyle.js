// The self-authored basemap style, replacing Carto Voyager.
//
// Voyager is a consumer basemap: every country border, every road, thousands of place labels.
// For an inbound-freight dashboard that ink is noise competing with the vessel and container
// icons that are the actual content. This style is built the other way round — nothing is drawn
// unless we asked for it. In particular it draws NO text at all: every label on the map comes
// from the curated list in src/data/places.js, and OSM's own `place`/`boundary` layers are
// simply never referenced.
//
// MapLibre's `style:` option takes a full style object, not just a URL, so swapping the basemap
// never touches the map init or computeMinZoom (CLAUDE.md §3, §11).
//
// TWO DATA SOURCES, each doing what only it can:
//
//   `openmaptiles` — OpenFreeMap's free, no-key planet tiles (OpenMapTiles schema, z0-14,
//     overzoomed above that). Owns water, land cover, roads and buildings. This is what makes
//     street-level detail possible for drayage routes; a vendored GeoJSON coastline never could.
//
//   `countries` / `states` — our own vendored Natural Earth geometry (tools/build-basemap-data.mjs).
//     Owns the continental-US contour and state hairlines. OSM's `boundary` layer can't do this:
//     it is all-or-nothing, and the whole point is that ONE country gets an outline. These fade
//     out around z9, where "which country is this" stops being the question.
//
// Glyphs: public/fonts/**, vendored SDF ranges — see tools/build-glyphs.mjs.

// Skin tokens are stored as space-separated RGB CHANNELS ("173 85 42") so Tailwind can compose
// them as `rgb(var(--c-x) / <alpha>)`. That is NOT a value MapLibre can parse, so every token
// has to be wrapped back into a real colour before it reaches a paint property.
export const skinRgb = (name, fallback) => {
  const channels =
    typeof window !== 'undefined' &&
    getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return channels ? `rgb(${channels})` : fallback
}

// GEOGRAPHY IS NOT SKINNED — on purpose.
//
// Everything else in the app follows the linen skin, and an earlier pass ran the map off it too:
// harbor water against fog land. Those ramps are built for UI surfaces that sit behind text, so
// the whole map came out as one flat warm field with barely a visible coastline. A map needs the
// familiar cartographic contract instead — blue reads as water, warm off-white reads as land —
// which is what Google Maps trained everyone on. So these are fixed cartographic colours.
//
// The skin still owns everything that means something in APP terms (the route line, the accent
// ring on our own ports) — see the skinRgb entries in mapPalette().
const GOOGLEISH = {
  water: '#aadaff', // Google's water blue
  land: '#f2efe9', // warm off-white landscape
  country: '#fbf9f6', // a touch lighter, so our countries lift off the rest of the world
  stateLine: '#c4bfb2', // darker than it looks: it's drawn dashed, so half of it is gap
  // PERFECTLY NEUTRAL dark grey — R, G and B are identical on purpose, so the line carries no
  // hue at all. Its predecessors were warm greys (#a09a8d, then #3c4043, which is faintly blue),
  // and a warm grey at hairline width reads as reddish-brown. Keep any replacement neutral:
  // don't reach for a "grey" out of the skin's fog ramp, which is warm by design.
  contour: '#8a8a8a',
  park: '#e4eddf',
  building: '#e3ded4',
  buildingLine: '#d3cdc1',
  motorway: '#f9d99f', // Google's highway amber
  motorwayCase: '#e9c589',
  road: '#ffffff',
  roadCase: '#ded9cf',
  labelPrimary: '#3c4043', // Google's primary label grey
  labelSecondary: '#5f6368', // Google's secondary label grey
  // The vessel hull's outline, from assets/vessel.svg. Lives here as well so the count badge's
  // ring and numeral share ONE source of truth with the icon they sit on — if the ship's outline
  // is ever recoloured, the badge follows instead of quietly drifting out of family.
  vesselOutline: '#086A08',
  // The rail marker's ink. Same hull as the ships, told apart by LIGHTNESS rather than hue — which
  // is what makes sharing a silhouette safe for a colour-blind reader. Perfectly neutral (R=G=B),
  // like the contour above and for the same reason. Must match the rail variant's fill in
  // tools/build-icons.mjs: the bake has its own literal, so the two are kept in step by hand.
  railInk: '#4A4A4A',
}

// Resolved once per call so the map re-reads the skin whenever the style is rebuilt.
export const mapPalette = () => ({
  water: GOOGLEISH.water,
  land: GOOGLEISH.land,
  country: GOOGLEISH.country,
  contour: GOOGLEISH.contour,
  stateLine: GOOGLEISH.stateLine,
  labelUs: GOOGLEISH.labelPrimary,
  labelIntl: GOOGLEISH.labelSecondary,
  dotIntl: GOOGLEISH.labelSecondary,
  dotFill: '#ffffff',
  vesselOutline: GOOGLEISH.vesselOutline,
  railInk: GOOGLEISH.railInk,
  // White, not the water colour: a label can sit over blue sea or off-white land, and a halo
  // tinted for one of them smudges against the other.
  labelHalo: '#ffffff',

  // App meaning, not cartography — these stay on the skin's accent.
  dotUs: skinRgb('--c-signal-600', 'rgb(173 85 42)'),
  route: skinRgb('--c-signal-600', 'rgb(173 85 42)'),
})

// Vendored via tools/build-glyphs.mjs. Only the ranges downloaded there exist — a place name
// using a character outside them renders blank.
export const FONT_REGULAR = ['Noto Sans Regular']
export const FONT_BOLD = ['Noto Sans Bold']

// Free, no API key, no account. Same host as our glyphs. To move to self-hosted PMTiles later,
// this URL is the only thing that changes — the schema and every layer below stay identical.
const OMT_URL = 'https://tiles.openfreemap.org/planet'
const NE_ATTRIBUTION = '<a href="https://www.naturalearthdata.com/">Natural Earth</a>'

// Where the vendored country geometry hands over to OpenMapTiles. Below this the country fills
// and contours are the point of the map; above it you're looking at one metro area, the outline
// would be coarser than the streets under it, and its near-white fill would paint over real
// rivers and bays. Fading rather than a hard `maxzoom` so nothing pops.
const US_FADE = [8.5, 10]

const fadeOut = ['interpolate', ['linear'], ['zoom'], US_FADE[0], 1, US_FADE[1], 0]
const fadeIn = ([from, to]) => ['interpolate', ['linear'], ['zoom'], from, 0, to, 1]

// Roads cascade in by importance rather than all at once, the way Google does it: interstates
// while you can still see three states, local streets only once you're over a neighbourhood.
// Turning them all on at one zoom either clutters the metro view or leaves it empty.
const PARK_FADE = [9, 10.5]

// A road tier = a casing line under a fill line. Both read the same width ramp so the casing
// stays a constant outline as the road thickens with zoom.
const roadTier = ({ id, classes, minzoom, fade, width, color, casing }) => [
  {
    id: `${id}-casing`,
    type: 'line',
    source: 'openmaptiles',
    'source-layer': 'transportation',
    minzoom,
    filter: ['all', ['match', ['get', 'class'], classes, true, false], ['!=', ['get', 'brunnel'], 'tunnel']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': casing,
      'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], ...width.flatMap(([z, w]) => [z, w + 1.6])],
      'line-opacity': fadeIn(fade),
    },
  },
  {
    id,
    type: 'line',
    source: 'openmaptiles',
    'source-layer': 'transportation',
    minzoom,
    filter: ['all', ['match', ['get', 'class'], classes, true, false], ['!=', ['get', 'brunnel'], 'tunnel']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': color,
      'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], ...width.flatMap(([z, w]) => [z, w])],
      'line-opacity': fadeIn(fade),
    },
  },
]

export function buildBasemapStyle() {
  const c = mapPalette()

  return {
    version: 8,
    glyphs: '/fonts/{fontstack}/{range}.pbf',
    // No `sprite` — every icon is registered at runtime with map.addImage (CLAUDE.md §10).
    sources: {
      openmaptiles: { type: 'vector', url: OMT_URL },
      countries: { type: 'geojson', data: '/data/countries.geojson', maxzoom: 10, attribution: NE_ATTRIBUTION },
      states: { type: 'geojson', data: '/data/us-states.geojson', maxzoom: 10 },
    },
    layers: [
      // Land is the background and water is painted ON TOP of it — the OpenMapTiles convention,
      // and the reverse of the vendored-GeoJSON version this replaced (which had a water
      // background with land polygons over it). Worth knowing before adding a layer: there is no
      // "land" polygon to reference, only the absence of water.
      { id: 'land', type: 'background', paint: { 'background-color': c.land } },

      {
        id: 'water',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'water',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'fill-color': c.water },
      },
      {
        id: 'waterway',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'waterway',
        minzoom: 8,
        paint: {
          'line-color': c.water,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 14, 2.4],
        },
      },

      // Green space, only once you're close enough for it to mean anything.
      {
        id: 'park',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'park',
        minzoom: 9,
        paint: { 'fill-color': GOOGLEISH.park, 'fill-opacity': fadeIn(PARK_FADE) },
      },

      // Buildings, for orienting inside a terminal or yard. Under the roads, never over them —
      // a building outline crossing a street reads as a mistake even when the geometry is right.
      {
        id: 'building',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 14,
        paint: {
          'fill-color': GOOGLEISH.building,
          'fill-outline-color': GOOGLEISH.buildingLine,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15.5, 1],
        },
      },

      // ── The continental US: our vendored geometry, low zoom only ─────────────────
      // Only the US gets a contour — goods move INTO it, so the destination is the thing worth
      // outlining. Outlining origin countries too was tried and removed: it cluttered the map and
      // diluted what the border is for. Origin ports already read as labelled dots.
      {
        id: 'countries-fill',
        type: 'fill',
        source: 'countries',
        paint: { 'fill-color': c.country, 'fill-opacity': fadeOut },
      },
      // State lines sit UNDER the contour so the outer edge stays one clean unbroken stroke.
      // They are reference for placing inland rail yards, not something to read — hence the
      // opacity ramp: barely there at world zoom, still faint once you're over the US.
      {
        id: 'us-states',
        type: 'line',
        source: 'states',
        // Butt caps, not round: round caps extend each dash by half the line width at both
        // ends, which closes up gaps this small and quietly turns the line solid again.
        layout: { 'line-join': 'round' },
        paint: {
          'line-color': c.stateLine,
          // dasharray units are MULTIPLES OF LINE WIDTH, not pixels — so this is ~2.4px of
          // dash to ~1.6px of gap, and changing line-width rescales the dashes with it.
          'line-dasharray': [3, 2],
          'line-width': 0.8,
          // Dashes read lighter than a solid stroke of the same weight (roughly half the ink),
          // so these sit a touch higher than the solid version did to land in the same place.
          'line-opacity': [
            'interpolate', ['linear'], ['zoom'],
            2, 0.35,
            5, 0.7,
            US_FADE[0], 0.7,
            US_FADE[1], 0,
          ],
        },
      },
      {
        id: 'countries-outline',
        type: 'line',
        source: 'countries',
        layout: { 'line-join': 'round' },
        paint: {
          'line-color': c.contour,
          // Thin, but nudged back up a hair from the near-black version: a mid grey carries less
          // weight per pixel than black, so 0.5px of it went faint at world zoom.
          'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.6, 6, 1.2],
          'line-opacity': fadeOut,
        },
      },

      // ── Roads, minor first so majors draw over them at junctions ──────────────────
      ...roadTier({
        id: 'road-minor',
        classes: ['minor', 'service', 'track'],
        minzoom: 12,
        fade: [12, 13],
        width: [[12, 0.4], [15, 1.8], [18, 8]],
        color: GOOGLEISH.road,
        casing: GOOGLEISH.roadCase,
      }),
      ...roadTier({
        id: 'road-secondary',
        classes: ['secondary', 'tertiary'],
        minzoom: 10,
        fade: [10.5, 12],
        width: [[10, 0.5], [14, 2.2], [18, 12]],
        color: GOOGLEISH.road,
        casing: GOOGLEISH.roadCase,
      }),
      ...roadTier({
        id: 'road-primary',
        classes: ['primary'],
        minzoom: 9,
        fade: [9, 10.5],
        width: [[9, 0.6], [14, 3], [18, 16]],
        color: GOOGLEISH.road,
        casing: GOOGLEISH.roadCase,
      }),
      // Highways last and amber — for drayage these are the ones you actually follow.
      ...roadTier({
        id: 'road-motorway',
        classes: ['motorway', 'trunk'],
        minzoom: 7,
        fade: [7.5, 9],
        width: [[8, 0.7], [14, 3.6], [18, 20]],
        color: GOOGLEISH.motorway,
        casing: GOOGLEISH.motorwayCase,
      }),
    ],
  }
}
