import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './MapView.css'

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
const INITIAL_CENTER = [0, 20]
const INITIAL_ZOOM = 1.5

// Min zoom where exactly one world copy fills the container width
// (vector tiles are 512px, so world width at zoom z is 512 * 2^z).
const computeMinZoom = (width) => Math.log2(width / 512)

export default function MapView() {
  const containerRef = useRef(null)
  const mapRef = useRef(null)

  useEffect(() => {
    const initialMinZoom = computeMinZoom(containerRef.current.clientWidth)

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: INITIAL_CENTER,
      zoom: Math.max(INITIAL_ZOOM, initialMinZoom),
      minZoom: initialMinZoom,
    })

    map.addControl(new maplibregl.NavigationControl(), 'top-right')

    map.on('resize', () => {
      map.setMinZoom(computeMinZoom(map.getContainer().clientWidth))
    })

    mapRef.current = map

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  return <div ref={containerRef} className="map-container" />
}
