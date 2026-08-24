import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './MapView.css'
import { useRoutes } from '../hooks/useRoutes'
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
import { placesFC, buildPlacesFC } from '../data/places'
import { useUsPorts } from '../hooks/useUsPorts'
import { useLoadingPorts } from '../hooks/useLoadingPorts'

const INITIAL_CENTER = [0, 20]
const INITIAL_ZOOM = 1.5
const SELECT_ZOOM = 5 // fly-to zoom when a vessel is selected (only zooms in, never out)
// OpenMapTiles is z0-14 and overzooms cleanly above that; 17 is enough to see individual
// buildings and yard entrances for drayage work without pushing the tiles past usefulness.
const MAX_ZOOM = 17

// Google-style label staging: a place appears — dot and name together — only once you've zoomed
// past the `minzoom` it carries in src/data/places.js, so the fully-zoomed-out world view is
// clean and places arrive in order of importance. MapLibre re-evaluates a zoom-dependent filter
// only at INTEGER zoom levels, which is why those minzooms are whole numbers.
const PLACE_ZOOM_FILTER = ['<=', ['get', 'minzoom'], ['zoom']]

// Container spiral, in SCREEN PIXELS. A touch tighter when fully zoomed out and through the
// first few zoom-ins, easing up to the base radius by ~zoom 6 (then steady).
const GOLDEN_ANGLE = (137.5 * Math.PI) / 180
const CONTAINER_RING_MIN_PX = 12 // fully zoomed out
const CONTAINER_RING_MAX_PX = 16 // zoom >= 6
const containerRingPx = (zoom) => {
  const t = Math.min(Math.max((zoom - 2) / (6 - 2), 0), 1)
  return CONTAINER_RING_MIN_PX + (CONTAINER_RING_MAX_PX - CONTAINER_RING_MIN_PX) * t
}

// Min zoom where exactly one world copy fills the container width
// (vector tiles are 512px, so world width at zoom z is 512 * 2^z).
const computeMinZoom = (width) => Math.log2(width / 512)

const EMPTY_FC = { type: 'FeatureCollection', features: [] }

// Build ship + container FeatureCollections and an id->{meta, remaining} lookup.
//   en-route -> ship, interpolated along the route (remaining = dashed-line coords)
//   arrived  -> container at the discharge port (+ golden-angle spiral offset), remaining=null
//   future   -> deferred
function buildFeatures(shipments, routesByKey, map) {
  const shipFeatures = []
  const byId = new Map()
  // Arrived shipments grouped by DISCHARGE PORT (regardless of route / port of loading).
  const arrivedByPod = new Map() // podKey -> { podCoords:[lng,lat], list:[shipment] }

  for (const s of shipments) {
    const coords = routesByKey.get(normalizeKey(s.route))
    if (!coords || coords.length < 2) continue
    const state = shipmentState(s)

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
        properties: { shipment: s.shipment, color, rotation: bearing - 90 },
      })
    } else if (state === 'arrived') {
      const podKey = normalizeKey(s.port_of_discharge)
      // Anchor every container at one canonical port point (first route seen for that port)
      // so containers from different routes/POLs still spiral around a shared center.
      if (!arrivedByPod.has(podKey)) {
        arrivedByPod.set(podKey, { podCoords: coords[coords.length - 1], list: [] })
      }
      arrivedByPod.get(podKey).list.push(s)
    }
  }

  // Spiral slots in SCREEN-PIXEL space so the fan is a constant size at every zoom (project
  // the port, offset in px, unproject). Sort by shipment id so each container keeps its slot /
  // position across refreshes and zoom (stable slots, §5.3). Slot 0 sits on the port.
  const containerFeatures = []
  const ring = containerRingPx(map.getZoom())
  for (const { podCoords, list } of arrivedByPod.values()) {
    list.sort((a, b) => (a.shipment < b.shipment ? -1 : a.shipment > b.shipment ? 1 : 0))
    const basePx = map.project(podCoords)
    list.forEach((s, index) => {
      let pos = podCoords
      if (index > 0) {
        const r = ring * Math.sqrt(index)
        const a = index * GOLDEN_ANGLE
        pos = map.unproject([basePx.x + Math.cos(a) * r, basePx.y + Math.sin(a) * r]).toArray()
      }
      byId.set(s.shipment, { meta: s, remaining: null })
      containerFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: pos },
        properties: { shipment: s.shipment, color: containerColor(s) },
      })
    })
  }

  return {
    shipFC: { type: 'FeatureCollection', features: shipFeatures },
    containerFC: { type: 'FeatureCollection', features: containerFeatures },
    byId,
  }
}

export default function MapView({ shipments, onSelect }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const vesselsByIdRef = useRef(new Map())
  const selectedIdRef = useRef(null)
  const [mapReady, setMapReady] = useState(false)

  const { routesByKey, error } = useRoutes()
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
    map.on('resize', () => {
      map.setMinZoom(computeMinZoom(map.getContainer().clientWidth))
    })

    map.on('load', async () => {
      const [def, grn, cBlue, cGreen, cRed] = await Promise.all([
        map.loadImage('/icons/nauticalDefault2.png'), // default vessel (MarineTraffic green)
        map.loadImage('/icons/nauticalGreen2.png'),
        map.loadImage('/icons/blueContainer.png'),
        map.loadImage('/icons/greenContainer.png'),
        map.loadImage('/icons/redContainer.png'),
      ])
      // Ships 60x49, containers 80x80 (Pillow/LANCZOS from 980/500px originals), tagged 2x
      // density so outlines stay crisp under GPU minification.
      if (!map.hasImage('shipDefault')) map.addImage('shipDefault', def.data, { pixelRatio: 2 })
      if (!map.hasImage('shipGreen')) map.addImage('shipGreen', grn.data, { pixelRatio: 2 })
      if (!map.hasImage('containerBlue')) map.addImage('containerBlue', cBlue.data, { pixelRatio: 2 })
      if (!map.hasImage('containerGreen')) map.addImage('containerGreen', cGreen.data, { pixelRatio: 2 })
      if (!map.hasImage('containerRed')) map.addImage('containerRed', cRed.data, { pixelRatio: 2 })

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
      map.addSource('containers', { type: 'geojson', data: EMPTY_FC })
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
          'icon-image': ['match', ['get', 'color'], 'green', 'shipGreen', 'shipDefault'],
          'icon-rotate': ['get', 'rotation'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          // 60x49 image @2x density => ~25px tall at size 1.0 (1:1 crisp at that size).
          'icon-size': ['interpolate', ['linear'], ['zoom'], 2, 0.6, 6, 1.0, 10, 1.4],
        },
      })

      map.addLayer({
        id: 'containers',
        type: 'symbol',
        source: 'containers',
        layout: {
          'icon-image': [
            'match',
            ['get', 'color'],
            'green', 'containerGreen',
            'red', 'containerRed',
            'containerBlue',
          ],
          'icon-allow-overlap': true,
          // 80x80 image @2x density => ~40px at size 1.0; these stops give ~24-44px square.
          'icon-size': ['interpolate', ['linear'], ['zoom'], 2, 0.6, 6, 0.8, 10, 1.1],
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

      for (const layer of ['vessels', 'containers']) {
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
        const hits = map.queryRenderedFeatures(e.point, { layers: ['vessels', 'containers'] })
        if (hits.length > 0) return
        clearSelection()
      })

      setMapReady(true)
    })

    return () => {
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

  // --- Build / refresh positions when data is ready (no animation; CLAUDE.md §6). ---
  // Recompute on zoomend so the pixel-space container spiral stays a constant on-screen size.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map || !routesByKey) return

    const rebuild = () => {
      const { shipFC, containerFC, byId } = buildFeatures(shipments, routesByKey, map)
      vesselsByIdRef.current = byId
      map.getSource('vessels')?.setData(shipFC)
      map.getSource('containers')?.setData(containerFC)

      // Keep the dashed line in sync if the selected ship still exists (containers have none).
      const selId = selectedIdRef.current
      const entry = selId ? byId.get(selId) : null
      map.getSource('remaining-route')?.setData(
        entry?.remaining
          ? { type: 'Feature', geometry: { type: 'LineString', coordinates: entry.remaining }, properties: {} }
          : EMPTY_FC,
      )

      if (import.meta.env.DEV) {
        console.log(`[MapView] ${shipFC.features.length} ships, ${containerFC.features.length} containers`)
      }
    }

    rebuild()
    map.on('zoomend', rebuild)
    return () => map.off('zoomend', rebuild)
  }, [mapReady, routesByKey, shipments])

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map-container" />
      {error ? <div className="map-error">Routes failed to load: {error.message}</div> : null}
    </div>
  )
}
