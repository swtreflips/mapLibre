import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// US ports and inland facilities, from `public.us_ports` in the shared Supabase project.
//
// This is the map's LOGISTICS layer: real terminals and inland yards at their own surveyed
// coordinates, not a hand-typed list. It replaced the hardcoded New York / Norfolk / Northampton
// entries that used to live in src/data/places.js — those were approximate and had to be edited
// by hand every time the network changed.
//
// `type` is the filter that matters:
//   'P'  seaport / marine terminal
//   'I'  inland facility (rail ramp, CY, container yard)
// Anything else in the table (airports, border crossings, etc.) is not a node in this network.
export const PORT_TYPES = ['P', 'I']

// The table carries `latitude` / `longitude` as plain doubles alongside a PostGIS `geom`, so
// there is nothing to parse — read the doubles and skip the geometry entirely.
const COLUMNS = 'id,name,canonical_name,unlocode,type,size,latitude,longitude,state_code'

export function useUsPorts() {
  const [usPorts, setUsPorts] = useState(null)
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
        .from('us_ports')
        .select(COLUMNS)
        .in('type', PORT_TYPES)

      if (cancelled) return
      if (err) {
        setError(err)
        setLoading(false)
        return
      }

      // Rows without coordinates can't be plotted; drop them rather than pushing NaN into GeoJSON,
      // which MapLibre renders as a silent no-op that looks like a missing port.
      const rows = (data ?? []).filter(
        (r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude),
      )

      if (rows.length === 0) {
        // us_ports already has GRANT ALL to anon, so a permission error is unlikely here — an
        // empty result almost always means RLS is enabled with no policy for anon.
        console.warn(
          '[useUsPorts] 0 US ports returned. us_ports has RLS enabled; anon holds the grant but ' +
            'needs a policy:\n' +
            '  create policy us_ports_anon_read on public.us_ports for select to anon using (true);',
        )
      } else if (import.meta.env.DEV) {
        const byType = rows.reduce((a, r) => ({ ...a, [r.type]: (a[r.type] ?? 0) + 1 }), {})
        console.log(`[useUsPorts] ${rows.length} US ports loaded`, byType)
      }

      setUsPorts(rows)
      setLoading(false)
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  return { usPorts, loading, error }
}
