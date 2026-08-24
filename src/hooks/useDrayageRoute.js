import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { decodeFlexPolyline } from '../lib/flexPolyline'

// One cached truck route from `drayage_routes`, keyed on the DIRECTIONAL city pair — the table is
// a HERE route cache, so (Atlanta, Pelham) and (Pelham, Atlanta) are separate rows.
//
// This is the road-following leg the ocean route can't give you: port/CY -> inland facility. It
// exists to prove the basemap's street detail is useful for drayage; the real feature would take
// the POD and Lastcy from a shipment rather than hardcoded endpoints.
//
// KEYS ARE STORED LOWERCASE ('atlanta, ga', not 'Atlanta, GA') — the cache is written that way by
// geoapi-next. PostgREST's `eq` is case-sensitive, so querying with the display casing matches
// nothing and returns an empty result rather than an error. Callers pass whatever casing reads
// naturally and this normalises; do not remove it.
const normalizeQuery = (s) => (s ?? '').trim().toLowerCase()

export function useDrayageRoute(originQuery, destinationQuery) {
  const [route, setRoute] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    if (!originQuery || !destinationQuery) return undefined

    async function load() {
      if (!supabase) return
      const { data, error: err } = await supabase
        .from('drayage_routes')
        .select('origin_query,destination_query,origin_lat,origin_lon,dest_lat,dest_lon,distance_m,duration_s,polyline,provider,transport_mode')
        .eq('origin_query', normalizeQuery(originQuery))
        .eq('destination_query', normalizeQuery(destinationQuery))
        .limit(1)

      if (cancelled) return
      if (err) {
        setError(err)
        return
      }
      const row = data?.[0]
      if (!row) {
        console.warn(
          `[useDrayageRoute] no cached route for ${originQuery} -> ${destinationQuery}. ` +
            'drayage_routes has RLS enabled; anon holds the grant but needs a policy:\n' +
            '  create policy drayage_routes_anon_read on public.drayage_routes for select to anon using (true);',
        )
        return
      }

      let coordinates
      try {
        coordinates = decodeFlexPolyline(row.polyline)
      } catch (e) {
        // Decoding is the one step that can be wrong-but-silent, so surface the provider: a
        // non-HERE row would need a different decoder entirely.
        console.error(`[useDrayageRoute] could not decode polyline (provider=${row.provider}):`, e.message)
        setError(e)
        return
      }

      if (import.meta.env.DEV) {
        console.log(
          `[useDrayageRoute] ${row.origin_query} -> ${row.destination_query}: ` +
            `${coordinates.length} points, ${(row.distance_m / 1000).toFixed(1)} km, ` +
            `${Math.round(row.duration_s / 60)} min (${row.provider}/${row.transport_mode})`,
        )
      }

      setRoute({ ...row, coordinates })
    }

    load()
    return () => {
      cancelled = true
    }
  }, [originQuery, destinationQuery])

  return { route, error }
}
