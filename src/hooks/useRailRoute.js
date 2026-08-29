import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// One rail route from `public.rail_routes`.
//
// The table has the SAME SHAPE as `sea_routes` — origin_port, destination_port, route_geom,
// geojson, routing_variant, distance_km, duration_hours, generated_at — so the geometry handling
// here is deliberately identical to useRoutes.js. If that normalization ever changes, change both.
//
// This is a HARDCODED TEST leg, the same way the drayage route was proved out: it exists to see
// what rail geometry looks like on this basemap. The real feature would take the pair from a
// shipment's intermodal leg rather than a constant in MapView.

// PostgREST `eq` is case-sensitive, and port names in these tables are NOT normalised at source
// (CLAUDE.md §4 — `Singapore`, `SINGAPORE` and `Singapore, Singapore` are three legal values).
// That mismatch is silent: a wrong-cased `eq` returns an empty result, not an error, which is
// exactly how the drayage lookup wasted an afternoon. `ilike` with no wildcards is an exact match
// that ignores case, so a lane fails to join only if the NAME is genuinely different.
export function useRailRoute(originPort, destinationPort) {
  const [route, setRoute] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    if (!originPort || !destinationPort) return undefined

    async function load() {
      if (!supabase) return
      const { data, error: err } = await supabase
        .from('rail_routes')
        .select('origin_port,destination_port,route_geom,geojson,distance_km,duration_hours')
        .ilike('origin_port', originPort)
        .ilike('destination_port', destinationPort)
        .limit(1)

      if (cancelled) return
      if (err) {
        setError(err)
        console.error('[useRailRoute]', err.message)
        return
      }

      const row = data?.[0]
      if (!row) {
        // An empty result here is ambiguous and the two causes need different fixes, so name both.
        // Measured at build time: rail_routes answers 200 with `content-range: */0` for anon while
        // every other table answers 206 with a real count — the signature of RLS with no policy.
        console.warn(
          `[useRailRoute] no row for ${originPort} -> ${destinationPort}. Either the lane is not ` +
            'in the table, or anon cannot read it. rail_routes needs BOTH a grant and a policy:\n' +
            '  grant select on public.rail_routes to anon;\n' +
            '  create policy rail_routes_anon_read on public.rail_routes for select to anon using (true);',
        )
        return
      }

      // Both geometry columns are selected because PostgREST can return a PostGIS column as GeoJSON
      // or as hex WKB depending on configuration; this fallback survives either.
      const geom = row.route_geom ?? row.geojson?.geometry
      if (geom?.type !== 'LineString' || !geom.coordinates?.length) {
        console.error('[useRailRoute] row found but geometry is not a usable LineString:', geom?.type)
        return
      }

      if (import.meta.env.DEV) {
        console.log(
          `[useRailRoute] ${row.origin_port} -> ${row.destination_port}: ` +
            `${geom.coordinates.length} points, ${row.distance_km ?? '?'} km, ` +
            `${row.duration_hours ?? '?'} h`,
        )
      }
      setRoute({ coordinates: geom.coordinates, distanceKm: row.distance_km, durationHours: row.duration_hours })
    }

    load()
    return () => {
      cancelled = true
    }
  }, [originPort, destinationPort])

  return { route, error }
}
