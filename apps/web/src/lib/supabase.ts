/**
 * The Supabase client — teacher authentication only.
 *
 * Students never touch Supabase. They sign in against our own API with a name and a PIN
 * and get an app-issued session cookie, because putting children in Supabase Auth would
 * need synthetic email identities and server-held passwords driven by the service_role
 * key: more moving parts and a larger blast radius than a revocable opaque cookie.
 *
 * So this module is only ever imported by the teacher screens, and the only key it uses
 * is the anon/publishable one. The service_role key must never appear in this app.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * True when the project has been configured. The app is built and tested before the
 * Supabase project exists, so sign-in has to fail with an explanation rather than a
 * crash on import — an unconfigured build should still serve `/join`, which needs no
 * Supabase at all.
 */
export const supabaseConfigured = Boolean(url && anonKey)

let client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (!supabaseConfigured) {
    throw new Error(
      'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in apps/web/.env.local.',
    )
  }
  client ??= createClient(url, anonKey, {
    auth: {
      // The teacher's session lives in this tab's storage and is restored on reload;
      // detectSessionInUrl is what consumes the magic-link fragment at /auth/callback.
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  })
  return client
}

/** Send a magic link. The redirect must be registered in Supabase's URL configuration. */
export async function sendMagicLink(email: string): Promise<void> {
  const { error } = await getSupabase().auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
  })
  if (error) throw new Error(error.message)
}

/**
 * The current access token, or null when signed out.
 *
 * Read fresh on every request rather than cached: supabase-js rotates the token in the
 * background, and a cached one becomes a 401 the teacher cannot explain or fix.
 */
export async function currentAccessToken(): Promise<string | null> {
  if (!supabaseConfigured) return null
  const { data } = await getSupabase().auth.getSession()
  return data.session?.access_token ?? null
}

export async function signOut(): Promise<void> {
  if (supabaseConfigured) await getSupabase().auth.signOut()
}
