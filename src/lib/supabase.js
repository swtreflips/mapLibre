import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Null when env is missing so the app degrades gracefully instead of throwing.
export const supabase = url && anonKey ? createClient(url, anonKey) : null

if (!supabase) {
  console.warn(
    '[supabase] Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — routes will not load. ' +
      'Add the anon (public) key to .env (never the service-role key).',
  )
}

// PostgREST caps a response at 1000 rows and says nothing about it: no error, no flag, just a
// shorter array. A query that fits today keeps working right up until the table grows past the cap,
// and then it silently starts returning a SUBSET — in no particular order, so which rows you lose
// is arbitrary.
//
// THIS ALREADY BIT ONCE. `sea_routes` held 486 rows when useRoutes was written, so reading it in one
// shot was fine. Generating the port matrices took it to 2,373, the app kept seeing 1,000 of them,
// and the missing lane happened to be Nhava Sheva -> Pipavav — so a vessel whose first leg had no
// geometry was dropped from the map entirely, with nothing anywhere saying why.
//
// Use this for any table read without a narrow filter. `build()` must return a fresh query builder
// each call, because a builder cannot be re-ranged once awaited.
const PAGE = 1000

export async function fetchAllRows(build) {
  const rows = []
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await build().range(start, start + PAGE - 1)
    if (error) return { data: null, error }
    rows.push(...(data ?? []))
    // A short page is the last page. An exactly-full one is ambiguous, so it costs one more request
    // to be sure rather than guessing.
    if ((data?.length ?? 0) < PAGE) return { data: rows, error: null }
  }
}
