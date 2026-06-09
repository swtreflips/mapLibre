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
} from '../lib/vesselMath'

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
const INITIAL_CENTER = [0, 20]
const INITIAL_ZOOM = 1.5

// Min zoom where exactly one world copy fills the container width
// (vector tiles are 512px, so world width at zoom z is 512 * 2^z).
const computeMinZoom = (width) => Math.log2(width / 512)

const EMPTY_FC = { type: 'FeatureCollection', features: [] }

// Build the vessel FeatureCollection (en-route only) + an id->{meta, remaining} lookup.
function buildVessels(shipments, routesByKey) {
  const features = []
  const byId = new Map()

  for (const s of shipments) {
    if (shipmentState(s) !== 'enroute') continue
    const coords = routesByKey.get(normalizeKey(s.route))
    if (!coords || coords.length < 2) continue

    const progress = computeProgress(parseYMD(s.actual_shipping), parseYMD(s.expected_portdate))
    const { pos, cut } = positionAtProgress(coords, progress)
    if (!pos) continue

    const next = coords[Math.min(cut + 1, coords.length - 1)]
    const bearing = computeBearing(pos, next)
    const color = s.arrival_notice?.toLowerCase() === 'yes' ? 'green' : 'default'
    const remaining = [pos, ...coords.slice(cut + 1)]

    byId.set(s.shipment, { meta: s, remaining })
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: pos },
      properties: {
        shipment: s.shipment,
        color,
        rotation: bearing - 90, // ship PNG points "east" at 0°; verify against sprite
      },
    })
  }

  return { fc: { type: 'FeatureCollection', features }, byId }
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
      const [def, grn] = await Promise.all([
        map.loadImage('/icons/nauticalWhite2.png'),
        map.loadImage('/icons/nauticalGreen2.png'),
      ])
      if (!map.hasImage('shipDefault')) map.addImage('shipDefault', def.data)
      if (!map.hasImage('shipGreen')) map.addImage('shipGreen', grn.data)

      map.addSource('vessels', { type: 'geojson', data: EMPTY_FC })
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
          // ship PNG is 980x606; these stops keep it ~18-45px tall across zoom (CLAUDE.md §5.5)
          'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.03, 6, 0.045, 10, 0.07],
        },
      })

      map.on('mouseenter', 'vessels', () => {
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', 'vessels', () => {
        map.getCanvas().style.cursor = ''
      })

      // Click a ship: select it + draw its dashed remaining route.
      map.on('click', 'vessels', (e) => {
        const id = e.features?.[0]?.properties?.shipment
        if (!id) return
        const entry = vesselsByIdRef.current.get(id)
        if (!entry) return
        selectedIdRef.current = id
        onSelect?.(entry.meta)
        map.getSource('remaining-route').setData({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: entry.remaining },
          properties: {},
        })
      })

      // Click empty map: clear selection + dashed line.
      map.on('click', (e) => {
        const hits = map.queryRenderedFeatures(e.point, { layers: ['vessels'] })
        if (hits.length > 0) return
        selectedIdRef.current = null
        onSelect?.(null)
        map.getSource('remaining-route').setData(EMPTY_FC)
      })

      setMapReady(true)
    })

    return () => {
      map.remove()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- Build / refresh vessel positions when data is ready (no animation; CLAUDE.md §6). ---
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map || !routesByKey) return

    const { fc, byId } = buildVessels(shipments, routesByKey)
    vesselsByIdRef.current = byId
    map.getSource('vessels')?.setData(fc)

    // Keep the dashed line in sync if the selected vessel still exists.
    const selId = selectedIdRef.current
    const entry = selId ? byId.get(selId) : null
    map.getSource('remaining-route')?.setData(
      entry
        ? { type: 'Feature', geometry: { type: 'LineString', coordinates: entry.remaining }, properties: {} }
        : EMPTY_FC,
    )

    if (import.meta.env.DEV) {
      console.log(`[MapView] plotted ${fc.features.length}/${shipments.length} vessels`)
    }
  }, [mapReady, routesByKey, shipments])

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map-container" />
      {error ? <div className="map-error">Routes failed to load: {error.message}</div> : null}
    </div>
  )
}
