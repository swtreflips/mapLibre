import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

/**
 * Who is signed in, if anyone.
 *
 * WHY THIS APP HAS A LOGIN AT ALL. It read reference data — ports, routes — with the anon key that
 * ships inside the JS bundle, and that was fine: a port coordinate is not a secret. Shipment data
 * is. `inbound_shipments` therefore grants nothing to anon and is gated on
 * `my_org_type() = 'internal'`, so reaching it requires a real session (CLAUDE.md §13).
 *
 * The map's other four tables keep their anon grants, so the basemap, ports and lanes still resolve
 * before anyone signs in. Only the boxes are behind the door.
 *
 * `loading` starts true and MUST be distinguished from "signed out". Rendering the login screen
 * while `getSession` is still in flight flashes it in front of someone who is already signed in,
 * every single reload.
 *
 * Mirrors RatesApp's AuthProvider (src/app/providers/AuthProvider.jsx): getSession once, then
 * onAuthStateChange for the rest of the tab's life, and a catch so an unreachable Supabase reads as
 * logged out rather than taking the app down.
 */
export function useSession() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    supabase?.auth
      .getSession()
      .then(({ data }) => {
        if (active) setSession(data?.session ?? null)
      })
      .catch(() => {
        // Supabase unreachable — a placeholder URL in dev, or offline. Treat as logged out.
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    // Not conditional on the call above resolving: a token refresh or a sign-out in another tab
    // has to reach this one too.
    const sub = supabase?.auth.onAuthStateChange((_event, next) => {
      if (active) setSession(next)
    })

    return () => {
      active = false
      sub?.data?.subscription?.unsubscribe()
    }
  }, [])

  return { session, loading }
}

/** Ends the session. The listener above clears state, so nothing here has to. */
export const signOut = () => supabase?.auth.signOut()
