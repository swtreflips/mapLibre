import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './MapView.css'
import { useRoutes } from '../hooks/useRoutes'
import LoadingScreen from './LoadingScreen'
import {
  computeProgress,
  positionAtProgress,
  computeBearing,
  containerColor,
} from '../lib/vesselMath'
import { buildBasemapStyle, mapPalette, FONT_REGULAR, FONT_BOLD } from '../map/basemapStyle'
import { placesFC, buildPlacesFC, portPointsByKey, FIRST_LABEL_ZOOM } from '../data/places'
import { portCardSvg, portCardLabel, portBubbleSvg, bubbleRadius, DIM_OPACITY } from '../map/portCard'
import { relaxOverlaps } from '../map/declutter'
import { buildHolders, etaDisagreements } from '../lib/holders'
import { useUsPorts } from '../hooks/useUsPorts'
import { useLoadingPorts } from '../hooks/useLoadingPorts'
import { useRailRoutes } from '../hooks/useRailRoute'

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

// A shallow ramp across the band where cards first appear, then flat.
//
// The low stop sits at FIRST_LABEL_ZOOM because that is where a card can first exist at all —
// below it a port draws a bubble, which is on its own curve. The top stop is where full size
// starts looking right; above it the table clamps, so 64 px holds all the way to z17.
//
// Tuned by eye, bounded by measurement. 0.55 at z3 was too far — the boxes stopped reading as
// containers; flat 1.0 was heavier than it needed to be. 0.7 sits between, and because the arms
// scale with the card it also tightens the spread where that matters most: a single-status pile
// sits ~185 km from its port at z3 rather than the ~265 km a full-size card gives.
const CARD_SCALE_STOPS = [
  [3, 0.7], // 45 px — cards appear
  [4.6, 1.0], // 64 px, and flat from here up
]

// Linear interpolation over a [zoom, value] stop table, clamped at both ends — the same thing
// MapLibre's ['interpolate', ['linear'], ['zoom'], ...] does internally. Shared so the DEV readout
// can report what a layer expression is currently evaluating to without duplicating the maths.
const interpolateStops = (stops, zoom) => {
  if (zoom <= stops[0][0]) return stops[0][1]
  if (zoom >= stops.at(-1)[0]) return stops.at(-1)[1]
  for (let i = 1; i < stops.length; i += 1) {
    const [z0, s0] = stops[i - 1]
    const [z1, s1] = stops[i]
    if (zoom <= z1) return s0 + ((zoom - z0) / (z1 - z0)) * (s1 - s0)
  }
  return stops.at(-1)[1]
}

const cardScale = (zoom) => interpolateStops(CARD_SCALE_STOPS, zoom)

// The bubble gets its own ramp, over the narrow band where a port is a dot on a continent.
// Observed at 1.59–2.19 on a 2x display: at the fully-zoomed-out end the disc is heavy for what it
// says, and by ~2.2 it sits right. Above that it holds full size until FIRST_LABEL_ZOOM hands over
// to the card, so this table stops there rather than running the whole range.
//
// Separate from CARD_SCALE_STOPS on purpose — the two forms never coexist, and their zoom bands
// barely touch, so one curve spanning both would be a curve fitted to nothing.
const BUBBLE_SCALE_STOPS = [
  [1.6, 0.72],
  [2.2, 1.0],
]
const bubbleScale = (zoom) => interpolateStops(BUBBLE_SCALE_STOPS, zoom)

// Min zoom where exactly one world copy fills the container width
// (vector tiles are 512px, so world width at zoom z is 512 * 2^z).
const computeMinZoom = (width) => Math.log2(width / 512)

const EMPTY_FC = { type: 'FeatureCollection', features: [] }

// The rail leg is drawn starting 3% along its lane, not at the port itself.
//
// A container that has just cleared its port is geometrically AT the port, which parks the railcar
// underneath that port's own container card — two things stacked on one point, neither readable.
// 3% of a 1,281 km lane is ~38 km.
//
// It is a PRESENTATION offset and it is one-sided: only the start moves. The end stays exact, so
// the box still lands on its yard precisely on expected_lastcy_date, which is the date anyone would
// check it against. Costs ~38 km of positional honesty on day one, on a position that is an
// estimate to begin with (§6).
//
// WHERE IT STOPS HELPING: the offset is a fraction of the LANE, but the thing it is dodging is a
// card of fixed PIXEL size. Measured against the New York card — clear from about z5.5 up (50 px
// at z6.5), but only ~5 px at z4, where the whole 1,281 km lane spans well under 200 px and the
// railcar still sits under the card. Fixing that properly means nudging in screen space, which is
// what relaxOverlaps in src/map/declutter.js already does for close ports.
const RAIL_START = 0.03
const railProgress = (p) => RAIL_START + p * (1 - RAIL_START)



// Search dimming for the vessel layer, sharing the port card's constant so a ghosted ship and a
// ghosted container box sit at the same remove. Every feature carries matched: 1 when no filter is
// active, so this reduces to a constant 1 and costs nothing until someone searches.
const MATCH_OPACITY = ['case', ['==', ['get', 'matched'], 1], 1, DIM_OPACITY]

// Build the vessel FeatureCollection, the port cards, and a key->holder lookup.
//   vessel holder -> one ship icon, interpolated along the route (remaining = dashed-line coords)
//   port holder   -> one card at the PORT's coordinate, remaining = null
//   future        -> deferred
//
// ONE FEATURE PER HOLDER, not per shipment. A vessel carrying three containers is one ship on the
// water, so it is one icon whose count badge says 3 — which is also what makes that badge honest.
// It read a hardcoded 7 for several iterations while every vessel in the data held exactly 1.
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

// Clear space to leave between two markers once they have been pushed apart, px.
const DECLUTTER_GAP = 5

// A card's art does not fill its box — the tri-arm footprint is wider than tall and there is
// padding around it — so its collision radius is a fraction of the rendered size rather than half.
const CARD_RADIUS_FACTOR = 0.42

// Nudge overlapping port markers apart, in PIXELS, so two close ports stay two readable markers.
//
// DOM markers get none of the collision handling a symbol layer has (CLAUDE.md §3) — that is the
// standing cost of drawing cards as markers, and this is what pays it. New York and Philadelphia
// are 130 km apart: about 4 px at world zoom, where the bubbles are ~25 px across, so they sat
// almost exactly on top of each other.
//
// The offset goes on the MARKER, never the lngLat: the marker still knows where its port really
// is, and the displacement is presentation only. It also composes cleanly with our inner-element
// transform, which MapLibre does not touch.
function applyPortDeclutter(map, ports, cards) {
  if (ports.length < 2) {
    for (const port of ports) cards.get(port.key)?.marker.setOffset([0, 0])
    return
  }
  const zoom = map.getZoom()
  const asCard = cardMode(zoom) === 'card'
  const scale = asCard ? cardScale(zoom) : bubbleScale(zoom)

  const points = ports.map((p) => map.project(p.coordinates))
  const radii = ports.map((p) =>
    asCard
      ? CARD_BASE_PX * scale * CARD_RADIUS_FACTOR
      : bubbleRadius(p.statuses.length) * scale,
  )
  const offsets = relaxOverlaps(points, radii, DECLUTTER_GAP)
  ports.forEach((port, i) => {
    // Markers that do not overlap get exactly [0, 0] back, so a lone port is never displaced and
    // every marker returns to its true position as soon as zoom separates them.
    cards.get(port.key)?.marker.setOffset(offsets[i])
  })
}

function syncPortCards(map, ports, cards, onPick) {
  const seen = new Set()
  const mode = cardMode(map.getZoom())

  for (const port of ports) {
    seen.add(port.key)
    // The card returns a centring translate alongside its markup (portCard.js); the bubble is
    // already drawn about its own origin and needs none.
    const { markup, dx, dy } =
      mode === 'card'
        ? portCardSvg(port.statuses, CARD_BASE_PX)
        : { markup: portBubbleSvg(port.statuses.length, port.matched), dx: 0, dy: 0 }
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
      // The click target is the PAINTED ART, not this box. `.port-card` keeps pointer-events:none
      // and the <svg> re-enables them, so SVG's default `visiblePainted` gives the hit test the
      // container silhouette itself — a click on a transparent corner of the 64px box still
      // reaches the map and pans it. Bound once here; the handler reads card.key at call time so
      // it survives every innerHTML swap.
      el.addEventListener('click', (ev) => {
        ev.stopPropagation() // otherwise the map's own click handler clears the selection again
        onPick?.(port.key)
      })
      // Both forms centre on the port now, so there is nothing to rebuild when the zoom threshold
      // is crossed — only the class and the markup change.
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat(port.coordinates)
        .addTo(map)
      card = { el, inner, marker, html: null, mode: null, key: port.key }
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

  applyPortDeclutter(map, ports, cards)
}

// `matchedIds` is null when no search filter is active, and a Set of shipment ids when one is.
// Null and "the empty set" mean different things and must stay distinct: null is "no filter, draw
// everything at full strength", empty is "a filter that matched nothing, dim the whole map".
function buildFeatures(shipments, routesByKey, railByKey, map, portPoints, matchedIds) {
  const mapBearing = map.getBearing()
  const isMatch = (c) => !matchedIds || matchedIds.has(c.shipment)
  const { vessels, trains, ports: portHolders } = buildHolders(shipments, routesByKey, portPoints, railByKey)
  const shipFeatures = []
  const railFeatures = []
  const railPaths = []
  // holder key -> { holder, remaining }. Selection is per HOLDER now, not per shipment: one icon
  // standing for three containers has no single shipment to show, which is exactly why the sidebar
  // became a tray.
  const byId = new Map()

  for (const v of vessels) {
    // The voyage's own dates, not any one container's — a ship is in one place, so rows that
    // disagree resolve to one position rather than smearing the vessel across the ocean.
    const progress = computeProgress(v.etd, v.eta)
    const { pos, cut } = positionAtProgress(v.coords, progress)
    if (!pos) continue
    const next = v.coords[Math.min(cut + 1, v.coords.length - 1)]
    const bearing = computeBearing(pos, next)
    // Arrival notice is a per-container fact but the hull is one object, so ANY container having
    // it turns the ship green. That matches what the colour is for — "something has landed at the
    // far end" — and a per-container breakdown is what the tray is for.
    const notified = v.containers.some((c) => c.arrival_notice?.toLowerCase() === 'yes')
    byId.set(v.key, { holder: v, remaining: [pos, ...v.coords.slice(cut + 1)] })
    shipFeatures.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: pos },
      properties: {
        holder: v.key,
        color: notified ? 'green' : 'default',
        rotation: bearing - 90,
        count: v.containers.length,
        textOffset: sternOffset(bearing, mapBearing),
        // ANY container aboard matching keeps the whole hull lit, the same "any" the arrival-notice
        // colour uses three lines up. A ship is one object in one place; it cannot be half-dimmed,
        // and which of its boxes matched is what the tray is for. Ports are the opposite case —
        // their card draws one box per container, so there the dimming goes per box.
        matched: v.containers.some(isMatch) ? 1 : 0,
      },
    })
  }

  // THE INLAND LEG. Same maths as the vessel — a thing travelling a polyline between two dates —
  // so it reuses computeProgress and positionAtProgress rather than reimplementing them. What
  // differs is only which lane and which pair of dates: the rail lane, and actual_portdate ->
  // expected_lastcy_date.
  for (const t of trains) {
    const progress = railProgress(computeProgress(t.etd, t.eta))
    const { pos, cut } = positionAtProgress(t.coords, progress)
    if (!pos) continue
    const next = t.coords[Math.min(cut + 1, t.coords.length - 1)]
    const bearing = computeBearing(pos, next)
    const remaining = [pos, ...t.coords.slice(cut + 1)]
    // `remaining: null` on purpose. The track ahead is drawn ALWAYS, by its own layer below, so
    // selection must not also push it into `remaining-route` — clicking a railcar fills the tray
    // and nothing else. `coordinates` carries the fly-to target that `remaining[0]` used to give.
    byId.set(t.key, { holder: { ...t, coordinates: pos }, remaining: null })
    railPaths.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: remaining },
      properties: { holder: t.key, matched: t.containers.some(isMatch) ? 1 : 0 },
    })
    railFeatures.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: pos },
      properties: {
        holder: t.key,
        rotation: bearing - 90,
        count: t.containers.length,
        textOffset: sternOffset(bearing, mapBearing),
        matched: t.containers.some(isMatch) ? 1 : 0,
      },
    })
  }

  // ONE CARD PER PORT, not one icon per container. The old golden-angle spiral fanned every
  // container around its port, which answered the wrong question — you counted scattered boxes
  // instead of reading a port's load at a glance, and a busy port became a smear.
  const ports = []
  for (const p of portHolders) {
    if (!p.coordinates) continue // neither a port row nor a route: nothing to anchor to
    byId.set(p.key, { holder: p, remaining: null })
    ports.push({
      key: p.key,
      name: p.name,
      coordinates: p.coordinates,
      anchored: Boolean(portPoints?.get(p.key)),
      statuses: p.containers.map((c) => ({ tone: containerColor(c), matched: isMatch(c) })),
      // Only for the zoomed-out bubble, which shows "2/5" rather than a stack. null with no filter
      // so the bubble knows to print a plain total.
      matched: matchedIds ? p.containers.filter(isMatch).length : null,
    })
  }

  return {
    shipFC: { type: 'FeatureCollection', features: shipFeatures },
    railFC: { type: 'FeatureCollection', features: railFeatures },
    railPathFC: { type: 'FeatureCollection', features: railPaths },
    ports,
    byId,
  }
}

// `matchedIds`: null when no search filter is active, otherwise the Set of shipment ids that match.
// MUST be referentially stable across renders — it is a dependency of the rebuild effect below, so
// a Set rebuilt inline every render would re-register the map listeners and redraw every vessel and
// port card on each keystroke in the search box. App memoizes it.
export default function MapView({ shipments, onSelect, matchedIds = null }) {
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
  // Port cards are DOM markers created outside the map's own event system, so they cannot go
  // through map.on('click', layer, ...). This ref lets a marker reach the selection handler that
  // is defined inside the one-time init effect.
  const selectHolderRef = useRef(null)
  const [mapReady, setMapReady] = useState(false)

  // `loading` was being discarded, so a slow route fetch was indistinguishable from a broken
  // map — the same failure Schedules shipped with. It now has a screen.
  const { routesByKey, loading, error } = useRoutes()
  const { usPorts } = useUsPorts()
  const { intlPorts } = useLoadingPorts()
  // Only the rail lanes this data actually uses. The table holds 540 of them at ~15 KB each, so
  // fetching the lot would be ~8 MB to draw the one or two that are in play.
  const railLanes = useMemo(
    () => [...new Set(shipments.map((s) => s.rail_route).filter(Boolean))],
    [shipments],
  )
  const { railByKey } = useRailRoutes(railLanes)

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
      const z = map.getZoom()
      containerRef.current?.style.setProperty('--card-scale', cardScale(z).toFixed(3))
      containerRef.current?.style.setProperty('--bubble-scale', bubbleScale(z).toFixed(3))
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
      syncPortCards(map, portsRef.current, cardsRef.current, (key) =>
        selectHolderRef.current?.(key),
      )
    }
    map.on('zoom', applyCardMode)

    // De-cluster continuously, not on zoomend: the offsets are a function of how far apart two
    // ports are ON SCREEN, which changes every frame of a zoom. Recomputing at the end would leave
    // markers visibly overlapping through the whole gesture and then snap. Projecting a handful of
    // points per frame is cheap; unlike the vessel pass this touches no GeoJSON.
    const applyDeclutter = () => applyPortDeclutter(map, portsRef.current, cardsRef.current)
    map.on('zoom', applyDeclutter)
    map.on('move', applyDeclutter)

    // --- DEV instrumentation ---------------------------------------------------------------
    //
    // Stripped from production: Vite replaces import.meta.env.DEV with a literal `false`, so this
    // whole block is dead code and the minifier removes it. Nothing below ships.
    let teardownDevTools = null
    if (import.meta.env.DEV) {
      // A console handle on the map. It deliberately lives in a ref and never in state (CLAUDE.md
      // §3), which also means devtools has no way to reach it — so `__map.getZoom()`,
      // `__map.setZoom(4)`, `__map.getCenter()` are otherwise impossible while tuning anything
      // zoom-staged.
      window.__map = map

      const hud = document.createElement('div')
      hud.className = 'map-hud'
      containerRef.current.appendChild(hud)
      const paintHud = () => {
        const z = map.getZoom()
        const card = cardMode(z) === 'card'
        const cs = card ? cardScale(z) : bubbleScale(z)
        hud.textContent =
          `z ${z.toFixed(2)}` +
          // Report whichever form is actually on screen — showing the card's scale while a bubble
          // is drawn is how you end up tuning a number that is doing nothing.
          `   ${cardMode(z)} ${cs.toFixed(2)}${card ? ` · ${(CARD_BASE_PX * cs).toFixed(0)}px` : ''}` +
          // A MIRROR of the layer's icon-size expression, not a readback from the renderer: both
          // are linear interpolation over the same stop table, so they agree — but if that layer
          // ever switches to an exponential base, this line goes stale silently.
          `   ship ${interpolateStops(VESSEL_SCALE_STOPS, z).toFixed(2)}` +
          `   dpr ${window.devicePixelRatio}`
      }
      paintHud()
      map.on('zoom', paintHud)
      teardownDevTools = () => {
        map.off('zoom', paintHud)
        hud.remove()
        if (window.__map === map) delete window.__map
      }
    }
    map.on('resize', () => {
      map.setMinZoom(computeMinZoom(map.getContainer().clientWidth))
    })

    map.on('load', async () => {
      // Containers are no longer sprites — a port draws one isometric card as a DOM marker
      // (src/map/portCard.js), so only the vessel tiers load here.
      const [def, grn, defSm, grnSm, rail, railSm] = await Promise.all([
        map.loadImage('/icons/nauticalDefault2.png'), // default vessel (MarineTraffic green)
        map.loadImage('/icons/nauticalGreen2.png'),
        map.loadImage('/icons/nauticalDefault2-sm.png'), // low-zoom tier, see below
        map.loadImage('/icons/nauticalGreen2-sm.png'),
        map.loadImage('/icons/railcar.png'), // the inland leg's marker, same two tiers
        map.loadImage('/icons/railcar-sm.png'),
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
      if (!map.hasImage('railcar')) map.addImage('railcar', rail.data, { pixelRatio: 2 })
      if (!map.hasImage('railcarSm')) map.addImage('railcarSm', railSm.data, { pixelRatio: 1 })

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

      // THE TRACK AHEAD. Always drawn, for every container currently on rail — not a selection
      // highlight. That is why it is quiet: a thin neutral dash rather than the accent
      // `remaining-route` uses, because the accent means "this is the one you picked" and using it
      // here would say that about every rail leg at once.
      //
      // Only the REMAINING portion. Track already covered is history, and the map is a picture of
      // where things are now.
      map.addSource('rail-remaining', { type: 'geojson', data: EMPTY_FC })
      map.addLayer({
        id: 'rail-remaining',
        type: 'line',
        source: 'rail-remaining',
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': '#5a5a5a',
          'line-width': 1.4,
          // Dash units are multiples of LINE WIDTH, not pixels (CLAUDE.md §15), so this changes if
          // the width does. Butt caps are required or round caps extend each dash and close the gaps.
          'line-dasharray': [3, 2.5],
          'line-opacity': ['case', ['==', ['get', 'matched'], 1], 0.65, DIM_OPACITY * 0.65],
        },
      })

      // THE INLAND LEG's marker. Same treatment as the vessel throughout — two size tiers
      // swapped at z4, rotation-alignment 'map', the count numeral trailing astern — because it is
      // the same kind of object: a thing moving along a line whose heading means something.
      //
      // One image, not two. The ship's amber/green encodes arrival_notice; rail has no equivalent
      // signal (assets/railcar.svg), so a second colour would imply a distinction that isn't there.
      map.addSource('rail-movers', { type: 'geojson', data: EMPTY_FC })
      map.addLayer({
        id: 'rail-movers',
        type: 'symbol',
        source: 'rail-movers',
        layout: {
          'icon-image': ['step', ['zoom'], 'railcarSm', 4, 'railcar'],
          'icon-rotate': ['get', 'rotation'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-size': vesselScaled(1),
          'text-field': ['case', ['>', ['get', 'count'], 1], ['to-string', ['get', 'count']], ''],
          'text-font': FONT_BOLD,
          'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 6, 12, 10, 16],
          'text-offset': ['get', 'textOffset'],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'icon-opacity': MATCH_OPACITY,
          // The rail marker's own ink, not the ships' green. The numeral belongs to the icon it
          // trails, and rail's contour is white — a white numeral would be invisible on this map,
          // so it takes the FILL colour instead.
          'text-color': palette.railInk,
          'text-halo-color': palette.labelHalo,
          'text-halo-width': 1.2,
          'text-opacity': MATCH_OPACITY,
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
          // Search dimming. `matched` is 1 for every feature when no filter is active, so this
          // expression is a no-op until someone searches — no second code path to keep in step.
          // Icon and text fade TOGETHER: a full-strength numeral over a ghosted hull would read as
          // the count being the match.
          'icon-opacity': MATCH_OPACITY,
          'text-opacity': MATCH_OPACITY,
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
      // Select a HOLDER — a vessel or a port — and hand it to the tray. One at a time, click to
      // toggle. Ports arrive here from a DOM marker rather than a rendered feature, so the
      // fly-to target comes from the holder rather than the event.
      const selectHolder = (key) => {
        if (!key) return
        if (selectedIdRef.current === key) {
          clearSelection()
          return
        }
        const entry = vesselsByIdRef.current.get(key)
        if (!entry) return
        selectedIdRef.current = key
        onSelect?.(entry.holder)
        map.getSource('remaining-route').setData(
          entry.remaining
            ? { type: 'Feature', geometry: { type: 'LineString', coordinates: entry.remaining }, properties: {} }
            : EMPTY_FC,
        )
        const center = entry.holder.coordinates ?? entry.remaining?.[0]
        if (center) {
          map.flyTo({ center, zoom: Math.max(map.getZoom(), SELECT_ZOOM), duration: 800 })
        }
      }
      selectHolderRef.current = selectHolder

      const handleFeatureClick = (e) => selectHolder(e.features?.[0]?.properties?.holder)

      for (const layer of ['vessels', 'rail-movers']) {
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
        const hits = map.queryRenderedFeatures(e.point, { layers: ['vessels', 'rail-movers'] })
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
      map.off('zoom', applyDeclutter)
      map.off('move', applyDeclutter)
      teardownDevTools?.()
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
      const { shipFC, railFC, railPathFC, ports, byId } = buildFeatures(
        shipments,
        routesByKey,
        railByKey,
        map,
        portPoints,
        matchedIds,
      )
      vesselsByIdRef.current = byId
      portsRef.current = ports
      cardModeRef.current = cardMode(map.getZoom())
      map.getSource('vessels')?.setData(shipFC)
      map.getSource('rail-movers')?.setData(railFC)
      map.getSource('rail-remaining')?.setData(railPathFC)
      syncPortCards(map, ports, cardsRef.current, (key) => selectHolderRef.current?.(key))

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
          `[MapView] ${shipFC.features.length} vessel holders, ${ports.length} port cards (${boxes} containers)` +
            (adrift.length ? ` — ${adrift.length} not matched to a port row: ${adrift.join(', ')}` : ''),
        )
        // Containers on one voyage carrying different ETAs. The vessel is drawn at the latest of
        // them (holders.js), so this is a data fault being resolved, not lost — say so.
        for (const d of etaDisagreements([...byId.values()].map((e) => e.holder).filter((h) => h.kind === 'vessel'))) {
          console.warn(
            `[MapView] ${d.vessel} (${d.route}) carries containers with different ETAs ` +
              `(${d.dates.join(', ')}); positioned at the latest.`,
          )
        }
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
  }, [mapReady, routesByKey, railByKey, shipments, portPoints, matchedIds])

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map-container" />
      {loading ? <LoadingScreen message="Plotting routes…" /> : null}
      {error ? <div className="map-error">Routes failed to load: {error.message}</div> : null}
    </div>
  )
}
