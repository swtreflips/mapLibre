import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './MapView.css'
import { useRoutes } from '../hooks/useRoutes'
import LoadingScreen from './LoadingScreen'
import {
  normalizeKey,
  parseYMD,
  computeProgress,
  positionAtProgress,
  computeBearing,
  shipmentState,
  containerColor,
} from '../lib/vesselMath'
import { buildBasemapStyle, mapPalette, FONT_REGULAR, FONT_BOLD } from '../map/basemapStyle'
import { placesFC, buildPlacesFC, portPointsByKey, FIRST_LABEL_ZOOM } from '../data/places'
import { portCardSvg, portCardLabel, portBubbleSvg } from '../map/portCard'
import { useUsPorts } from '../hooks/useUsPorts'
import { useLoadingPorts } from '../hooks/useLoadingPorts'

const INITIAL_CENTER = [0, 20]
const INITIAL_ZOOM = 1.5
const SELECT_ZOOM = 5 // fly-to zoom when a vessel is selected (only zooms in, never out)
// OpenMapTiles is z0-14 and overzooms cleanly above that; 17 is enough to see individual
// buildings and yard entrances for drayage work without pushing the tiles past usefulness.
const MAX_ZOOM = 17

// The vessel's size curve, in one place because the count badge rides it too. If the hull and the
// badge ever diverge, the bubble slides off the ship as you zoom.
//
// It is a STOP TABLE rather than a finished expression for a reason: `['zoom']` must sit at the
// TOP LEVEL of a paint/layout property. Writing `['*', radius, <zoom interpolate>, <data expr>]`
// is invalid — and MapLibre does not reject it, it accepts the layer and then evaluates the
// property to 0, so the circle is simply invisible with nothing in the console. Baking the
// multiplier into the stop OUTPUTS keeps zoom at the top level, which is legal and does work.
const VESSEL_SCALE_STOPS = [
  [2, 0.6],
  [6, 1.0],
  [10, 1.4],
]

// base -> zoom interpolate on the vessel curve. `perFeature`, if given, is a data expression
// multiplied into each stop output (legal there; illegal wrapped around the whole thing).
const vesselScaled = (base, perFeature) => [
  'interpolate',
  ['linear'],
  ['zoom'],
  ...VESSEL_SCALE_STOPS.flatMap(([z, s]) => [
    z,
    perFeature ? ['*', base * s, perFeature] : base * s,
  ]),
]

// How far astern the container count sits, in EMS of its own text-size. The hull's half-length is
// ~15 CSS px at icon-size 1.0 where text-size is 12px, so 1.5em ≈ 18px clears the stern. Because
// ems scale with text-size, the gap drifts only ~10% across the whole zoom range even though the
// text and hull curves differ — close enough to stay a constant rather than a second expression.
const STERN_EM = 1.5

// Google-style label staging: a place appears — dot and name together — only once you've zoomed
// past the `minzoom` it carries in src/data/places.js, so the fully-zoomed-out world view is
// clean and places arrive in order of importance. MapLibre re-evaluates a zoom-dependent filter
// only at INTEGER zoom levels, which is why those minzooms are whole numbers.
const PLACE_ZOOM_FILTER = ['<=', ['get', 'minzoom'], ['zoom']]

// Port cards are DOM markers, so unlike a symbol layer they do NOT scale with the map. This
// mirrors the icon-size curve the container symbols used, applied as a CSS transform — without
// it a card that reads well at z6 dominates the world view.
//
// Sizing history: the container sprites this replaced were 40 CSS px on the same curve, and at 72
// the card spanned ~1,200 km at world zoom and swallowed the northeast US. The tri-arm card is ~2x
// wider than the single mixed stack it replaced (three 2-wide footprints side by side instead of
// one), and the square viewBox fits by width — so at the old 44 the boxes came out half-size. 64
// splits the difference: boxes ~73% of the old size, card ~46% wider on screen.
const CARD_BASE_PX = 64

// The curve now STARTS at the zoom cards start existing at (FIRST_LABEL_ZOOM = 3); below that a
// port draws a bubble, which opts out of this scale entirely, so the old z2 stop was describing
// something that no longer renders.
//
// Rebalanced because that extra width lands hardest where there is least room for it. The top of
// the curve is UNCHANGED — 1.1 at z10, where a card sits over a single metro and has the space —
// and the bottom is pulled down to 0.45, which puts the card at 28.8 CSS px the moment it appears.
// That is not a guessed number: it is what the old single-stack card measured at the same zoom, so
// the tri-arm card at its smallest costs no more screen than the thing it replaced.
// FLAT ON PURPOSE — the zoom ramp is switched off, not deleted.
//
// 35 px at z3 read as too small, so this reverts to a constant 64 px: exactly what was on screen
// before the centring fix, since --card-scale was inert then (see syncPortCards). Running it flat
// isolates the two changes, so what you judge now is the centring alone.
//
// The trade it re-accepts: the arms scale with the card, so at full size a single-status pile sits
// ~265 km from its port at z3 (Boston is 306 km from New York). That is well in from the 592 km it
// was, but it is the reason the ramp existed. Put values back in the middle stop to bring it back —
// or, to keep the boxes big AND the piles tight, ramp ARM_R in portCard.js instead, which pulls the
// arms in without shrinking the containers.
const CARD_SCALE_STOPS = [
  [3, 1.0], // 64 px
  [10, 1.0], // 64 px
]
const cardScale = (zoom) => {
  const stops = CARD_SCALE_STOPS
  if (zoom <= stops[0][0]) return stops[0][1]
  if (zoom >= stops.at(-1)[0]) return stops.at(-1)[1]
  for (let i = 1; i < stops.length; i += 1) {
    const [z0, s0] = stops[i - 1]
    const [z1, s1] = stops[i]
    if (zoom <= z1) return s0 + ((zoom - z0) / (z1 - z0)) * (s1 - s0)
  }
  return 1
}

// Min zoom where exactly one world copy fills the container width
// (vector tiles are 512px, so world width at zoom z is 512 * 2^z).
const computeMinZoom = (width) => Math.log2(width / 512)

const EMPTY_FC = { type: 'FeatureCollection', features: [] }

// MOCK. Every vessel claims 7 containers so the badge can be built and judged before the grouping
// logic exists. The real version changes what a FEATURE IS: group en-route shipments by vessel and
// emit one feature per group with count = group.length, instead of one per shipment. Note that
// breaks the sidebar's 1:1 selection (vesselsByIdRef maps one id to one shipment) — one icon
// standing for 7 containers has no single shipment to show. See CLAUDE.md §8.
const MOCK_CONTAINER_COUNT = 7

// Build ship + container FeatureCollections and an id->{meta, remaining} lookup.
//   en-route -> ship, interpolated along the route (remaining = dashed-line coords)
//   arrived  -> counted into its discharge port's card, at the PORT's coordinate, remaining=null
//   future   -> deferred
// Unit vector pointing ASTERN, in text-offset's frame: ems, +x right, +y down.
//
// `mapBearing` has to come off the vessel's bearing because text-offset is SCREEN space, whereas
// icon-rotate (with rotation-alignment 'map') already accounts for the map's own rotation. Without
// this every numeral slides off its stern the moment the map is rotated.
//
// Check: bearing 90 (heading east) -> [-D, 0], numeral to the left, i.e. behind it.
//        bearing 0  (heading north) -> [0, +D], numeral below. Correct.
function sternOffset(bearing, mapBearing) {
  const theta = ((bearing - mapBearing) * Math.PI) / 180
  return [-STERN_EM * Math.sin(theta), STERN_EM * Math.cos(theta)]
}

// Reconcile the live markers against the ports that currently have containers.
//
// Update / create / REMOVE, in that order. The removal pass is the one that matters: a marker that
// is never removed is a card stuck on the map for the rest of the session, showing containers that
// have since been delivered. `cards` is a Map keyed by port so this stays O(n) and each card keeps
// its DOM element (and any hover state) across refreshes instead of being torn down and rebuilt.
// Which form a port draws at this zoom. Above the first port label, the full isometric card;
// below it, a bubble carrying the total. See portBubbleSvg for why.
const cardMode = (zoom) => (zoom >= FIRST_LABEL_ZOOM ? 'card' : 'bubble')

function syncPortCards(map, ports, cards) {
  const seen = new Set()
  const mode = cardMode(map.getZoom())

  for (const port of ports) {
    seen.add(port.key)
    // The card returns a centring translate alongside its markup (portCard.js); the bubble is
    // already drawn about its own origin and needs none.
    const { markup, dx, dy } =
      mode === 'card'
        ? portCardSvg(port.statuses, CARD_BASE_PX)
        : { markup: portBubbleSvg(port.statuses.length), dx: 0, dy: 0 }
    const label = portCardLabel(port.name, port.statuses)
    let card = cards.get(port.key)

    if (!card) {
      // TWO ELEMENTS, and the split is load-bearing. MapLibre writes `element.style.transform`
      // inline on the marker element every time it repositions, and an inline style beats a
      // stylesheet rule on the same element — so a `transform` of ours on the marker element is
      // silently discarded. (That is exactly what happened: --card-scale was inert for several
      // iterations and every card rendered at a constant CARD_BASE_PX.) The outer div is
      // MapLibre's; the inner one is ours. Don't merge them.
      const el = document.createElement('div')
      el.className = 'port-card'
      const inner = document.createElement('div')
      el.appendChild(inner)
      // Both forms centre on the port now, so there is nothing to rebuild when the zoom threshold
      // is crossed — only the class and the markup change.
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat(port.coordinates)
        .addTo(map)
      card = { el, inner, marker, html: null, mode: null }
      cards.set(port.key, card)
    }

    card.marker.setLngLat(port.coordinates)
    if (card.mode !== mode) {
      card.inner.className = mode === 'card' ? 'port-card__inner' : 'port-card__inner--bubble'
      card.mode = mode
    }
    // Only touch innerHTML when the stack actually changed — reassigning it every refresh would
    // rebuild the SVG DOM and throw away any in-flight CSS transition.
    if (card.html !== markup) {
      card.inner.innerHTML = markup
      card.inner.style.setProperty('--card-dx', `${dx.toFixed(2)}px`)
      card.inner.style.setProperty('--card-dy', `${dy.toFixed(2)}px`)
      card.html = markup
    }
    card.el.title = label
    card.el.setAttribute('aria-label', label)
  }

  for (const [key, card] of cards) {
    if (seen.has(key)) continue
    card.marker.remove()
    cards.delete(key)
  }
}

function buildFeatures(shipments, routesByKey, map, portPoints) {
  const mapBearing = map.getBearing()
  const shipFeatures = []
  const byId = new Map()
  // Arrived shipments grouped by DISCHARGE PORT (regardless of route / port of loading).
  const arrivedByPod = new Map() // podKey -> { routeEnd:[lng,lat]|null, list:[shipment] }

  for (const s of shipments) {
    const state = shipmentState(s)

    // ARRIVED containers are handled BEFORE the route lookup, because they no longer need one:
    // a container sitting at a port is placed by the port, not by how it got there. That also
    // closes a silent drop — port names in this data are not normalised (CLAUDE.md §4), so a lane
    // whose route failed to join used to take its arrived containers down with it.
    if (state === 'arrived') {
      const podKey = normalizeKey(s.port_of_discharge)
      if (!podKey) continue
      if (!arrivedByPod.has(podKey)) arrivedByPod.set(podKey, { routeEnd: null, list: [] })
      const group = arrivedByPod.get(podKey)
      // Kept only as a fallback for a port with no row in `us_ports` / `world_ports`. Taken from
      // whichever shipment first offers a usable route, not necessarily the first in the group.
      if (!group.routeEnd) {
        const c = routesByKey.get(normalizeKey(s.route))
        if (c && c.length >= 2) group.routeEnd = c[c.length - 1]
      }
      group.list.push(s)
      continue
    }

    const coords = routesByKey.get(normalizeKey(s.route))
    if (!coords || coords.length < 2) continue

    if (state === 'enroute') {
      const progress = computeProgress(parseYMD(s.actual_shipping), parseYMD(s.expected_portdate))
      const { pos, cut } = positionAtProgress(coords, progress)
      if (!pos) continue
      const next = coords[Math.min(cut + 1, coords.length - 1)]
      const bearing = computeBearing(pos, next)
      const color = s.arrival_notice?.toLowerCase() === 'yes' ? 'green' : 'default'
      byId.set(s.shipment, { meta: s, remaining: [pos, ...coords.slice(cut + 1)] })
      shipFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: pos },
        properties: {
          shipment: s.shipment,
          color,
          rotation: bearing - 90,
          count: MOCK_CONTAINER_COUNT,
          textOffset: sternOffset(bearing, mapBearing),
        },
      })
    }
  }

  // ONE CARD PER PORT, not one icon per container. The old golden-angle spiral fanned every
  // container around its port, which answered the wrong question — you counted scattered boxes
  // instead of reading a port's load at a glance, and a busy port became a smear.
  //
  // arrivedByPod already did the grouping; only what gets emitted changes. Sort by shipment id so
  // a container keeps its slot in the stack across refreshes rather than shuffling.
  const ports = []
  for (const [podKey, { routeEnd, list }] of arrivedByPod) {
    // THE PORT'S OWN COORDINATE — the very point its label is drawn at. The sea route's last
    // vertex is only a fallback for a port with no row in the ports tables, since that endpoint is
    // a node in a shipping-lane graph rather than the terminal itself and can sit visibly offshore.
    const anchored = portPoints?.get(podKey)
    const coordinates = anchored ?? routeEnd
    if (!coordinates) continue // neither a port row nor a route: nothing to anchor to
    list.sort((a, b) => (a.shipment < b.shipment ? -1 : a.shipment > b.shipment ? 1 : 0))
    for (const s of list) byId.set(s.shipment, { meta: s, remaining: null })
    ports.push({
      key: podKey,
      name: list[0]?.port_of_discharge ?? podKey,
      coordinates,
      anchored: Boolean(anchored),
      statuses: list.map((s) => containerColor(s)),
    })
  }

  return {
    shipFC: { type: 'FeatureCollection', features: shipFeatures },
    ports,
    byId,
  }
}

export default function MapView({ shipments, onSelect }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const vesselsByIdRef = useRef(new Map())
  // port key -> { el, marker, html }. Lives in a ref, not state: markers are imperative DOM
  // that must survive re-renders, and mutating them should never trigger one.
  const cardsRef = useRef(new Map())
  // Last built ports + which form they are drawn in, so the zoom handler can swap between the card
  // and the bubble without re-running the whole vessel pass.
  const portsRef = useRef([])
  const cardModeRef = useRef(null)
  const selectedIdRef = useRef(null)
  const [mapReady, setMapReady] = useState(false)

  // `loading` was being discarded, so a slow route fetch was indistinguishable from a broken
  // map — the same failure Schedules shipped with. It now has a screen.
  const { routesByKey, loading, error } = useRoutes()
  const { usPorts } = useUsPorts()
  const { intlPorts } = useLoadingPorts()

  // --- Map init (once). Do not rewrite this block. ---
  useEffect(() => {
    const initialMinZoom = computeMinZoom(containerRef.current.clientWidth)

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildBasemapStyle(),
      center: INITIAL_CENTER,
      zoom: Math.max(INITIAL_ZOOM, initialMinZoom),
      minZoom: initialMinZoom,
      maxZoom: MAX_ZOOM,
    })
    mapRef.current = map

    map.addControl(new maplibregl.NavigationControl(), 'top-right')

    // Port cards are DOM, so they do not scale with the map the way the old container sprites
    // did. One CSS custom property on the container drives every card at once — cheaper than
    // touching each marker, and it rides the same curve the sprites used.
    const applyCardScale = () => {
      containerRef.current?.style.setProperty('--card-scale', cardScale(map.getZoom()).toFixed(3))
    }
    applyCardScale()
    map.on('zoom', applyCardScale)

    // Card <-> bubble on the `zoom` event rather than `zoomend`, so the swap lands as you cross the
    // threshold instead of snapping after you let go. The guard keeps it to a comparison per frame:
    // real work happens only on a crossing. Positions still recompute on zoomend only (CLAUDE.md §6).
    const applyCardMode = () => {
      const mode = cardMode(map.getZoom())
      if (mode === cardModeRef.current) return
      cardModeRef.current = mode
      syncPortCards(map, portsRef.current, cardsRef.current)
    }
    map.on('zoom', applyCardMode)
    map.on('resize', () => {
      map.setMinZoom(computeMinZoom(map.getContainer().clientWidth))
    })

    map.on('load', async () => {
      // Containers are no longer sprites — a port draws one isometric card as a DOM marker
      // (src/map/portCard.js), so only the vessel tiers load here.
      const [def, grn, defSm, grnSm] = await Promise.all([
        map.loadImage('/icons/nauticalDefault2.png'), // default vessel (MarineTraffic green)
        map.loadImage('/icons/nauticalGreen2.png'),
        map.loadImage('/icons/nauticalDefault2-sm.png'), // low-zoom tier, see below
        map.loadImage('/icons/nauticalGreen2-sm.png'),
      ])
      // Ships rasterised from assets/vessel.svg, tagged 2x density so outlines stay crisp
      // under GPU minification.
      if (!map.hasImage('shipDefault')) map.addImage('shipDefault', def.data, { pixelRatio: 2 })
      if (!map.hasImage('shipGreen')) map.addImage('shipGreen', grn.data, { pixelRatio: 2 })
      // The -sm tier is a 33x28 bitmap, so it registers at pixelRatio 1 — that gives it the same
      // ~33 CSS px logical width as the full tier, which is what keeps the z4 swap size-neutral.
      // Registering it at 2 like the others would draw it at half size.
      if (!map.hasImage('shipDefaultSm')) map.addImage('shipDefaultSm', defSm.data, { pixelRatio: 1 })
      if (!map.hasImage('shipGreenSm')) map.addImage('shipGreenSm', grnSm.data, { pixelRatio: 1 })

      const palette = mapPalette()

      // Ports / inland facilities (src/data/places.js). The DOT goes on before the vessels so
      // a ship passing over a port covers it — the ship is the point of interest. The LABELS go
      // on after, at the very top, so a name is never hidden behind an icon.
      // Seeded with the international list only; the US ports arrive from Supabase and are
      // swapped in by the effect below once they resolve.
      map.addSource('places', { type: 'geojson', data: placesFC })

      map.addLayer({
        id: 'place-dots',
        type: 'circle',
        source: 'places',
        filter: PLACE_ZOOM_FILTER,
        paint: {
          // White fill + coloured stroke reads as a hollow ring at these radii.
          'circle-color': palette.dotFill,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 2.5, 6, 4],
          'circle-stroke-width': 1.4,
          'circle-stroke-color': [
            'match',
            ['get', 'kind'],
            'intl_port', palette.dotIntl,
            palette.dotUs,
          ],
        },
      })

      map.addSource('vessels', { type: 'geojson', data: EMPTY_FC })
      map.addSource('remaining-route', { type: 'geojson', data: EMPTY_FC })

      map.addLayer({
        id: 'remaining-route',
        type: 'line',
        source: 'remaining-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': palette.route,
          'line-width': 1.8,
          'line-opacity': 0.85,
          'line-dasharray': [2, 2],
        },
      })

      // Drayage: the road-following truck leg, from the HERE route cache. Deliberately SOLID and
      // heavier where the ocean leg is dashed and thin — the two are told apart by line style, not
      // colour, so the distinction survives for a colourblind reader. A white casing underneath
      // keeps it legible once the street grid fades in around z11.
      //
      // DORMANT: nothing feeds this source yet, so it draws nothing. The plumbing is verified
      // end to end (see src/hooks/useDrayageRoute.js and src/lib/flexPolyline.js) — wiring it up
      // is one useDrayageRoute() call keyed on the selected shipment's POD -> Lastcy, plus a
      // setData in an effect. Two things to settle when you do:
      //   - draw only while a shipment is selected, the way remaining-route does;
      //   - gate it to the roads' z7.5-9 fade, or it floats over blank land at country zoom.
      map.addSource('drayage-route', { type: 'geojson', data: EMPTY_FC })
      map.addLayer({
        id: 'drayage-route-casing',
        type: 'line',
        source: 'drayage-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.9 },
      })
      map.addLayer({
        id: 'drayage-route',
        type: 'line',
        source: 'drayage-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': palette.route,
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2, 12, 4],
        },
      })

      map.addLayer({
        id: 'vessels',
        type: 'symbol',
        source: 'vessels',
        layout: {
          // TWO SIZE TIERS. MapLibre scales sprites with GPU bilinear filtering and no mipmaps,
          // so below ~z4 the 66px bitmap is minified hard enough that the 2px outline lands under
          // one device pixel and drops out — measured at dpr 2 / z1.5, the dark contour survived
          // on only 53% of the silhouette, in different places at each heading. That crawling
          // edge is the artifact. The -sm bitmap is baked near its display size (so the GPU
          // barely resamples it) with a proportionally heavier stroke.
          //
          // Both tiers are ~33 CSS px logical, so this swaps WEIGHT, not size — see
          // tools/build-icons.mjs.
          'icon-image': [
            'step',
            ['zoom'],
            ['match', ['get', 'color'], 'green', 'shipGreenSm', 'shipDefaultSm'],
            4,
            ['match', ['get', 'color'], 'green', 'shipGreen', 'shipDefault'],
          ],
          'icon-rotate': ['get', 'rotation'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          // 60x49 image @2x density => ~25px tall at size 1.0 (1:1 crisp at that size).
          'icon-size': vesselScaled(1),

          // --- Container count, trailing the stern ---
          //
          // On THIS layer, not a layer of its own: a symbol carries an icon and text together,
          // and their rotations are independent. `icon-rotate` spins the hull while text keeps
          // the default `text-rotation-alignment: viewport` and stays upright. That is the whole
          // mechanism — there is no per-frame maths and nothing to keep in sync.
          //
          // An empty string renders no glyphs, so a single-container vessel is simply a ship.
          'text-field': ['case', ['>', ['get', 'count'], 1], ['to-string', ['get', 'count']], ''],
          'text-font': FONT_BOLD,
          // Deliberately FLATTER than the hull's curve (vesselScaled). The hull shrinks to 0.6x
          // at world zoom; a numeral doing the same would be ~7px and unreadable — which is the
          // whole point of this being a trailing numeral rather than a badge inside the hull.
          'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 6, 12, 10, 16],
          // Per-feature unit vector pointing astern, baked in buildFeatures. Must stay a bare
          // ['get'] — text-offset accepts zoom AND feature parameters, so wrapping it in a zoom
          // expression is tempting and is invalid: MapLibre accepts it silently then evaluates
          // to 0, which is how the previous bubble rendered invisibly with a clean console.
          'text-offset': ['get', 'textOffset'],
          // Keep the numeral with its ship rather than letting collision drop it.
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          // The hull's own outline colour, so the number reads as belonging to that ship. Held
          // constant across both ship variants on purpose: the numeral means "how many", the hull
          // colour means "arrival notice" — one glyph should not encode two things.
          'text-color': palette.vesselOutline,
          // No bubble any more, so the numeral sits straight on water or land and needs its own
          // separation. Same halo treatment the port labels use.
          'text-halo-color': palette.labelHalo,
          'text-halo-width': 1.2,
        },
      })

      // Place labels, on top of everything.
      map.addLayer({
        id: 'place-labels',
        type: 'symbol',
        source: 'places',
        filter: PLACE_ZOOM_FILTER,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': [
            'match',
            ['get', 'kind'],
            'intl_port', ['literal', FONT_REGULAR],
            ['literal', FONT_BOLD],
          ],
          'text-size': ['interpolate', ['linear'], ['zoom'], 3, 11, 7, 13],
          'text-anchor': 'left',
          'text-offset': [0.7, 0],
          'text-letter-spacing': 0.01,
          'text-padding': 4,
          // Let a crowded coast drop names instead of stacking them. Sorting by the same
          // minzoom that gates the place means importance decides who keeps their name: a
          // major port beats the rail yard next to it, which stays a bare dot until you zoom.
          'text-allow-overlap': false,
          'text-optional': true,
          'symbol-sort-key': ['get', 'minzoom'],
        },
        paint: {
          'text-color': [
            'match',
            ['get', 'kind'],
            'intl_port', palette.labelIntl,
            palette.labelUs,
          ],
          'text-halo-color': palette.labelHalo,
          'text-halo-width': 1.4,
          'text-halo-blur': 0.2,
        },
      })

      const clearSelection = () => {
        selectedIdRef.current = null
        onSelect?.(null)
        map.getSource('remaining-route').setData(EMPTY_FC)
      }

      // Toggle selection (one at a time, ships + containers). Selecting flies to center+zoom;
      // ships also draw their dashed remaining route (containers have remaining=null).
      const handleFeatureClick = (e) => {
        const feature = e.features?.[0]
        const id = feature?.properties?.shipment
        if (!id) return

        if (selectedIdRef.current === id) {
          clearSelection()
          return
        }

        const entry = vesselsByIdRef.current.get(id)
        if (!entry) return
        selectedIdRef.current = id
        onSelect?.(entry.meta)
        map.getSource('remaining-route').setData(
          entry.remaining
            ? { type: 'Feature', geometry: { type: 'LineString', coordinates: entry.remaining }, properties: {} }
            : EMPTY_FC,
        )
        map.flyTo({
          center: feature.geometry.coordinates,
          zoom: Math.max(map.getZoom(), SELECT_ZOOM),
          duration: 800,
        })
      }

      for (const layer of ['vessels']) {
        map.on('mouseenter', layer, () => {
          map.getCanvas().style.cursor = 'pointer'
        })
        map.on('mouseleave', layer, () => {
          map.getCanvas().style.cursor = ''
        })
        map.on('click', layer, handleFeatureClick)
      }

      // Click empty map: clear selection + dashed line.
      map.on('click', (e) => {
        const hits = map.queryRenderedFeatures(e.point, { layers: ['vessels'] })
        if (hits.length > 0) return
        clearSelection()
      })

      setMapReady(true)
    })

    // Captured now, not read at cleanup time: by then cardsRef.current may point at a different
    // Map, and we would tear down the wrong registry (or none).
    const cards = cardsRef.current

    return () => {
      // Markers are attached to the map but owned by us; map.remove() drops their DOM, so clear
      // the registry too or a remount starts with a Map full of dead references.
      for (const { marker } of cards.values()) marker.remove()
      cards.clear()
      map.off('zoom', applyCardScale)
      map.remove()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- Swap in the ports once Supabase answers. ---
  // Both sources feed one `places` source, and they resolve independently, so this reruns on
  // either and rebuilds from whatever has arrived. Separate from the vessel effect below: places
  // are static reference geometry with no projection-dependent maths, so they never need
  // recomputing on zoomend.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map || (!usPorts && !intlPorts)) return
    map.getSource('places')?.setData(buildPlacesFC({ usPorts, intlPorts }))
  }, [mapReady, usPorts, intlPorts])

  // Where the port cards get anchored: the ports' own coordinates, the same ones the labels above
  // are drawn at. Memoized because it is a dependency of the rebuild effect — rebuilt inline it
  // would be a new object every render and re-run the whole vessel pass on each one.
  const portPoints = useMemo(() => portPointsByKey({ usPorts, intlPorts }), [usPorts, intlPorts])

  // --- Build / refresh positions when data is ready (no animation; CLAUDE.md §6). ---
  // Recompute on zoomend so the pixel-space container spiral stays a constant on-screen size.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map || !routesByKey) return

    const rebuild = () => {
      const { shipFC, ports, byId } = buildFeatures(shipments, routesByKey, map, portPoints)
      vesselsByIdRef.current = byId
      portsRef.current = ports
      cardModeRef.current = cardMode(map.getZoom())
      map.getSource('vessels')?.setData(shipFC)
      syncPortCards(map, ports, cardsRef.current)

      // Keep the dashed line in sync if the selected ship still exists (containers have none).
      const selId = selectedIdRef.current
      const entry = selId ? byId.get(selId) : null
      map.getSource('remaining-route')?.setData(
        entry?.remaining
          ? { type: 'Feature', geometry: { type: 'LineString', coordinates: entry.remaining }, properties: {} }
          : EMPTY_FC,
      )

      if (import.meta.env.DEV) {
        const boxes = ports.reduce((n, p) => n + p.statuses.length, 0)
        // A card that fell back to the route endpoint means its port_of_discharge has no row in
        // us_ports / world_ports — almost always a name that drifted, not a missing port. Worth
        // naming, because the card still draws and the miss would otherwise be invisible.
        const adrift = ports.filter((p) => !p.anchored).map((p) => p.name)
        console.log(
          `[MapView] ${shipFC.features.length} ships, ${ports.length} port cards (${boxes} containers)` +
            (adrift.length ? ` — ${adrift.length} not matched to a port row: ${adrift.join(', ')}` : ''),
        )
      }
    }

    rebuild()
    map.on('zoomend', rebuild)
    // ...and on rotateend, because the vessel count's text-offset is SCREEN space: rotating the
    // map turns every hull (icon-rotation-alignment 'map' handles that) but would leave the
    // numerals pointing the old way. `rotateend` rather than `rotate` — recomputing mid-drag is
    // wasted work, and the map is north-up in normal use.
    map.on('rotateend', rebuild)
    return () => {
      map.off('zoomend', rebuild)
      map.off('rotateend', rebuild)
    }
  }, [mapReady, routesByKey, shipments, portPoints])

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map-container" />
      {loading ? <LoadingScreen message="Plotting routes…" /> : null}
      {error ? <div className="map-error">Routes failed to load: {error.message}</div> : null}
    </div>
  )
}
