import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

/**
 * The shipments the map draws: the latest `inbound_shipments` row.
 *
 * A PUSH REPLACES, IT DOES NOT MERGE. Each NetSuite export is inserted whole and the newest row IS
 * the current picture — so this is one read, `order by uploaded_at desc limit 1`, with no reconciling
 * against what came before. Earlier rows stay as history, where a bad push can be seen for what it
 * was. Same contract as RatesApp's booking snapshots
 * (src/features/internal/bookings/snapshotService.js), deliberately.
 *
 * The payload arrives already in the shape the components consume — Shipment[] each with items[] —
 * because the push builds it that way. Nothing is mapped here.
 *
 * NO PAGING, unlike useRoutes. That one reads thousands of rows and was silently truncated at
 * PostgREST's 1000-row cap; this reads exactly ONE row whose payload happens to be an array, so the
 * cap cannot apply however many shipments it holds.
 *
 * KEYED ON THE USER ID, NOT THE SESSION OBJECT. Supabase hands out a new session object on every
 * token refresh — roughly hourly — and depending on it would refetch the whole payload each time
 * for data that has not changed.
 *
 * `loading` IS DERIVED, NOT STORED. Setting it synchronously inside the effect is what
 * react-hooks/set-state-in-effect forbids, and rightly: two pieces of state describing one fact
 * drift the moment a session changes mid-flight. "Signed in but the answer has not arrived for THIS
 * user yet" is a question the data already answers.
 */
export function useInboundSnapshot(session) {
  const userId = session?.user?.id ?? null

  // `for` records which user the result belongs to, so a sign-in as someone else does not briefly
  // show the previous account's snapshot while the new fetch is in flight.
  const [entry, setEntry] = useState({ for: null, snapshot: null, error: null })

  useEffect(() => {
    // No synchronous setState here — see the note above. `inbound_shipments` grants nothing to
    // anon, so an unauthenticated read is a guaranteed permission error; asking anyway would put
    // one in the console on every visit to the login screen and train everyone to ignore it.
    if (!supabase || !userId) return undefined

    let active = true

    supabase
      .from('inbound_shipments')
      .select('id, uploaded_at, file_name, shipment_count, item_count, payload')
      .order('uploaded_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return
        if (error) console.error('[useInboundSnapshot]', error.message)
        setEntry({
          for: userId,
          error: error ?? null,
          // An EMPTY TABLE IS A NORMAL FIRST-RUN STATE, not an error: nothing has been pushed yet.
          snapshot: data
            ? {
                id: data.id,
                uploadedAt: data.uploaded_at,
                fileName: data.file_name,
                shipmentCount: data.shipment_count ?? 0,
                itemCount: data.item_count ?? 0,
                shipments: data.payload ?? [],
              }
            : null,
        })
      })

    return () => {
      active = false
    }
  }, [userId])

  const ready = Boolean(userId) && entry.for === userId

  return {
    // An empty array rather than null, so every consumer can map over it without a guard.
    shipments: ready ? (entry.snapshot?.shipments ?? []) : [],
    snapshot: ready ? entry.snapshot : null,
    loading: Boolean(userId) && !ready,
    error: ready ? entry.error : null,
  }
}
