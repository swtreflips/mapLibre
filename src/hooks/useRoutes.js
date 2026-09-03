import { useEffect, useState } from 'react'
import { supabase, fetchAllRows } from '../lib/supabase'
import { normalizeKey } from '../lib/vesselMath'

// Routes live in the SHARED Supabase project (the RatesApp consolidation), in `sea_routes` —
// not the old standalone project's `routes` table, which was deprovisioned along with it.
//
// Supabase `sea_routes` row -> { key, coordinates:[[lng,lat],...] }.
// Schema: origin_port, destination_port, route_geom (geometry(LineString,4326)),
//         geojson (Feature, jsonb), routing_variant, distance_km, duration_hours.
//
// Both geometry columns are selected because PostgREST can hand back a PostGIS column as GeoJSON
// or as hex WKB depending on configuration; the fallback below survives either. If `route_geom`
// proves to come back as GeoJSON, drop `geojson` from the select — it duplicates the whole
// geometry across ~180 rows for nothing.
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
      // `routing_variant` is pinned to 'default' deliberately. Its PK is
      // (origin_port, destination_port, routing_variant), because one port pair can be sailed two
      // genuinely different ways — Nhava Sheva -> Rotterdam via Suez or via the Cape. Every row is
      // 'default' today, so an unfiltered query would still work; but routesByKey is keyed on
      // "POL - POD" alone, so the moment variant rows land, two rows collide on one key and the
      // last one silently wins. Pinning here costs nothing and closes that before it can bite.
      // PAGED, because sea_routes is well past PostgREST's 1000-row cap: the two port matrices took
      // it from 486 rows to 2,373. Read in one shot it returned exactly 1000 with no error and no
      // warning, and the lanes that fell outside were simply absent — a vessel whose first leg was
      // one of them vanished from the map with nothing to say why. See fetchAllRows.
      const { data, error: err } = await fetchAllRows(() =>
        supabase
          .from('sea_routes')
          .select('origin_port,destination_port,route_geom,geojson,routing_variant')
          .eq('routing_variant', 'default'),
      )
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
        console.warn(
          '[useRoutes] 0 routes returned. sea_routes has RLS enabled and the anon role needs BOTH ' +
            'a grant and a policy:\n' +
            '  grant select on public.sea_routes to anon;\n' +
            "  create policy sea_routes_anon_read on public.sea_routes for select to anon using (true);",
        )
      } else if (import.meta.env.DEV) {
        console.log(`[useRoutes] ${map.size} routes loaded from sea_routes`)
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
