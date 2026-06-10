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

// Basemap style. Voyager = colorful/Google-Maps-like (blue water, clean for overlays).
// Alternatives: Positron (grey, minimal) | OpenFreeMap Liberty
//   'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
//   'https://tiles.openfreemap.org/styles/liberty'
const STYLE_URL = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json'
const INITIAL_CENTER = [0, 20]
const INITIAL_ZOOM = 1.5
const SELECT_ZOOM = 5 // fly-to zoom when a vessel is selected (only zooms in, never out)

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

  // --- Map init (once). Do not rewrite this block. ---
  useEffect(() => {
    const initialMinZoom = computeMinZoom(containerRef.current.clientWidth)

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: INITIAL_CENTER,
      zoom: Math.max(INITIAL_ZOOM, initialMinZoom),
      minZoom: initialMinZoom,
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

      map.addSource('vessels', { type: 'geojson', data: EMPTY_FC })
      map.addSource('containers', { type: 'geojson', data: EMPTY_FC })
      map.addSource('remaining-route', { type: 'geojson', data: EMPTY_FC })

      map.addLayer({
        id: 'remaining-route',
        type: 'line',
        source: 'remaining-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#1d4ed8',
          'line-width': 1.8,
          'line-opacity': 0.85,
          'line-dasharray': [2, 2],
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
