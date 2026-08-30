import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { normalizeKey } from '../lib/vesselMath'

// Rail lanes from `public.rail_routes`, for the inland leg between a discharge port and an
// interior yard.
//
// The table has the SAME SHAPE as `sea_routes` — origin_port, destination_port, route_geom,
// geojson, routing_variant, distance_km, duration_hours — so this mirrors useRoutes.js. If that
// normalization changes, change both.
//
// ONLY THE LANES ACTUALLY IN USE ARE FETCHED. The table holds 540 lanes (20 US seaports x 27
// inland ramps) and one lane's geometry is ~15 KB, so pulling the lot would be roughly 8 MB on
// every load to draw one line. sea_routes gets away with fetching everything because it is 180
// rows; this does not.
//
// `route_geom` alone, without `geojson`: measured, it comes back as GeoJSON rather than hex WKB on
// this project, and dropping the duplicate column halves the payload (15 KB a lane against 31 KB).
// If a deployment ever returns WKB here, the symptom is a lane that silently fails to draw — add
// `geojson` back and fall back the way normalizeRoute does.
const COLUMNS = 'origin_port,destination_port,route_geom'

// "New York, NY - Cincinnati, OH" -> ['New York, NY', 'Cincinnati, OH'].
// The separator is " - " with spaces, because the port names themselves contain commas and, in
// "Washington - Dulles" style names, hyphens.
function splitLane(lane) {
  const i = lane.indexOf(' - ')
  return i === -1 ? null : [lane.slice(0, i).trim(), lane.slice(i + 3).trim()]
}

// PostgREST needs commas inside a value escaped, or they terminate the filter argument. Every port
// name here has one ("Cincinnati, OH"), so this is not an edge case.
const quote = (v) => `"${v.replace(/"/g, '\\"')}"`

const EMPTY = new Map()

/**
 * @param {string[]} lanes  distinct `rail_route` strings, e.g. ['New York, NY - Cincinnati, OH']
 * @returns {{railByKey: Map<string, number[][]>|null, error: Error|null}}
 */
export function useRailRoutes(lanes) {
  const [fetched, setFetched] = useState(null)
  const [error, setError] = useState(null)

  // Stable across renders unless the actual set of lanes changes — otherwise a new array literal
  // from the caller would refetch on every render.
  const laneKey = useMemo(() => [...new Set(lanes ?? [])].sort().join('|'), [lanes])

  useEffect(() => {
    let cancelled = false
    // No lanes is not a fetch result, so it is DERIVED below rather than stored — setting state
    // synchronously in an effect body just to represent "nothing to do" is a cascading render for
    // no reason.
    const wanted = laneKey ? laneKey.split('|') : []
    if (!wanted.length) return undefined

    async function load() {
      if (!supabase) return

      const pairs = wanted.map(splitLane).filter(Boolean)
      if (!pairs.length) {
        console.warn('[useRailRoutes] no lane parsed as "Origin - Destination":', wanted)
        setFetched(EMPTY)
        return
      }

      // ilike, not eq: PostgREST's eq is case-sensitive and port names in these tables are not
      // normalised at source (CLAUDE.md §4), so a casing mismatch returns an empty result rather
      // than an error — silent, and exactly how the drayage lookup lost an afternoon.
      const filter = pairs
        .map(([o, d]) => `and(origin_port.ilike.${quote(o)},destination_port.ilike.${quote(d)})`)
        .join(',')

      const { data, error: err } = await supabase.from('rail_routes').select(COLUMNS).or(filter)

      if (cancelled) return
      if (err) {
        setError(err)
        console.error('[useRailRoutes]', err.message)
        return
      }

      const map = new Map()
      for (const row of data ?? []) {
        const geom = row.route_geom
        if (geom?.type !== 'LineString' || !geom.coordinates?.length) continue
        map.set(normalizeKey(`${row.origin_port} - ${row.destination_port}`), geom.coordinates)
      }

      if (map.size === 0) {
        // Two causes, different fixes, so name both. Measured during development: rail_routes
        // answered 200 with `content-range: */0` for anon while every other table answered 206
        // with a real count — the signature of RLS enabled with no policy.
        console.warn(
          `[useRailRoutes] 0 of ${pairs.length} lane(s) resolved. Either the lane is not in the ` +
            'table, or anon cannot read it. rail_routes needs BOTH a grant and a policy:\n' +
            '  grant select on public.rail_routes to anon;\n' +
            '  create policy rail_routes_anon_read on public.rail_routes for select to anon using (true);',
        )
      } else if (import.meta.env.DEV) {
        const pts = [...map.values()].reduce((n, c) => n + c.length, 0)
        console.log(
          `[useRailRoutes] ${map.size}/${pairs.length} rail lane(s), ${pts} points total`,
        )
      }
      setFetched(map)
    }

    load()
    return () => {
      cancelled = true
    }
  }, [laneKey])

  // EMPTY when there is nothing to fetch, null while a fetch is outstanding, the map once it
  // lands. Callers can tell "no rail in this data" from "not loaded yet".
  const railByKey = laneKey ? fetched : EMPTY
  return { railByKey, error }
}
