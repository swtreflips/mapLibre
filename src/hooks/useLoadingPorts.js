import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { INTL_PORTS } from '../data/places'

// International load ports: a CURATED list of names (src/data/places.js), with coordinates read
// live from `world_ports` — the single source of truth for where a port actually is.
//
// It deliberately does NOT read `schedules`. That table was used once to derive which ports we
// load from, and the answer was frozen into INTL_PORTS; querying it at runtime would mean an
// unfamiliar port appearing in the feed silently rewrites the map. (It is also unreadable from
// the browser by design — it holds carrier codes and raw_schedule payloads, and the anon key
// ships in the JS bundle.) The `map_loading_ports` view still exists as the tool for RE-deriving
// the list when the network changes; it is not a runtime dependency.
//
// This is the opposite of the US side on purpose: `us_ports` is read live so the map grows with
// operations, while the international list only changes when someone decides it should.
const COLUMNS = 'canonical_name,latitude,longitude,country_name,size,unlocode'

export function useLoadingPorts() {
  const [intlPorts, setIntlPorts] = useState(null)
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
        .from('world_ports')
        .select(COLUMNS)
        .in('canonical_name', INTL_PORTS)

      if (cancelled) return
      if (err) {
        setError(err)
        setLoading(false)
        return
      }

      const rows = (data ?? []).filter(
        (r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude),
      )

      if (rows.length === 0) {
        console.warn(
          '[useLoadingPorts] 0 international ports returned. world_ports has RLS enabled and anon ' +
            'needs BOTH a grant and a policy:\n' +
            '  grant select on public.world_ports to anon;\n' +
            "  create policy world_ports_anon_read on public.world_ports for select to anon using (true);",
        )
      } else if (rows.length < INTL_PORTS.length) {
        // The `in` filter matches exactly, so a name that drifted from world_ports drops out with
        // no error. Name it rather than letting a port quietly vanish from the map.
        const got = new Set(rows.map((r) => r.canonical_name))
        console.warn(
          '[useLoadingPorts] no world_ports match for:',
          INTL_PORTS.filter((n) => !got.has(n)),
        )
      } else if (import.meta.env.DEV) {
        console.log(`[useLoadingPorts] ${rows.length} international load ports loaded`)
      }

      setIntlPorts(rows)
      setLoading(false)
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  return { intlPorts, loading, error }
}
