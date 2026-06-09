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
