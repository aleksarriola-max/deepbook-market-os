import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

// Null when env vars are missing (e.g. local dev before Task 1's .env.local
// is set up) — callers in cloudState.ts treat this the same as "no wallet
// address set": skip the network call, fall back to local-only state.
export const supabase: SupabaseClient | null = url && anonKey ? createClient(url, anonKey) : null
