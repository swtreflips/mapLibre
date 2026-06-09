import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { normalizeKey } from '../lib/vesselMath'

// Supabase `routes` row -> { key, coordinates:[[lng,lat],...] }.
// Schema: origin_port, destination_port, route_geom (GeoJSON LineString), geojson (Feature).
function normalizeRoute(row) {
  const key = normalizeKey(`${row.origin_port} - ${row.destination_port}`)
  const geom = row.route_geom ?? row.geojson?.geometry
  const coordinates = geom?.type === 'LineString' ? geom.coordinates : null
  return { key, coordinates }
}

// Fetch routes once and return a Map keyed by normalizeKey("POL - POD") -> coordinates.
export function useRoutes() {
  const [routesByKey, setRoutesByKey] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!supabase) {
        setError(new Error('Supabase not configured (missing VITE_SUPABASE_ANON_KEY)'))
        setLoading(false)
        return
      }
      const { data, error: err } = await supabase
        .from('routes')
        .select('origin_port,destination_port,route_geom')
      if (cancelled) return
      if (err) {
        setError(err)
        setLoading(false)
        return
      }
      const map = new Map()
      for (const row of data ?? []) {
        const r = normalizeRoute(row)
        if (r.coordinates) map.set(r.key, r.coordinates)
      }
      if (map.size === 0) {
        console.warn('[useRoutes] 0 routes returned — check RLS read access for the anon key.')
      }
      setRoutesByKey(map)
      setLoading(false)
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  return { routesByKey, loading, error }
}
