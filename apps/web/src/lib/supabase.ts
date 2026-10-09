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

import { AuthError, createClient, type SupabaseClient } from '@supabase/supabase-js'

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
      // detectSessionInUrl is what consumes the token in the URL when a verification
      // link lands on /auth/callback, or a reset link on /reset-password.
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  })
  return client
}

/** The shortest password the sign-up and reset forms accept. Set the same in Supabase. */
export const MIN_PASSWORD = 10

/**
 * Something about signing in that the person can fix — a wrong password, an unverified
 * email — as opposed to Supabase being unreachable. The screens show the first as
 * `not-yet` and the second as `system-error`, the palette rule applied to auth.
 */
export class AuthProblem extends Error {
  readonly fixable: boolean
  constructor(message: string, fixable: boolean) {
    super(message)
    this.fixable = fixable
  }
}

const FIXABLE: Record<string, string> = {
  invalid_credentials: 'That email and password don’t match.',
  email_not_confirmed: 'Check your email and click the link to verify your account first.',
  weak_password: `Choose a longer password — at least ${MIN_PASSWORD} characters.`,
  same_password: 'That’s your current password. Choose a new one.',
  over_email_send_rate_limit: 'Too many emails just now. Wait a minute and try again.',
  over_request_rate_limit: 'Too many tries just now. Wait a minute and try again.',
  user_already_exists: 'There’s already an account for this email. Sign in instead.',
  email_address_invalid: 'That doesn’t look like an email address.',
}

function problem(error: unknown): AuthProblem {
  if (error instanceof AuthError && error.code && error.code in FIXABLE) {
    return new AuthProblem(FIXABLE[error.code]!, true)
  }
  const message = error instanceof Error ? error.message : String(error)
  return new AuthProblem(message || 'Sign-in is unavailable right now.', false)
}

export interface AuthFailure {
  message: string
  /** True for `not-yet` (the person can fix it), false for `system-error`. */
  fixable: boolean
}

/** Any auth error as something a screen can show, with its palette tone. */
export function authFailure(error: unknown): AuthFailure {
  const p = error instanceof AuthProblem ? error : problem(error)
  return { message: p.message, fixable: p.fixable }
}

const callbackUrl = () => `${window.location.origin}/auth/callback`

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await getSupabase().auth.signInWithPassword({ email: email.trim(), password })
  if (error) throw problem(error)
}

/**
 * Create the account and send the verification email. Resolves `'exists'` when the
 * address already has a verified account: Supabase then answers with a user that has
 * no identities and sends nothing, so "check your email" would be a wait for nothing.
 */
export async function signUp(
  name: string,
  email: string,
  password: string,
): Promise<'sent' | 'exists'> {
  const { data, error } = await getSupabase().auth.signUp({
    email: email.trim(),
    password,
    options: { data: { full_name: name.trim() }, emailRedirectTo: callbackUrl() },
  })
  if (error) throw problem(error)
  return data.user && data.user.identities?.length === 0 ? 'exists' : 'sent'
}

export async function resendVerification(email: string): Promise<void> {
  const { error } = await getSupabase().auth.resend({
    type: 'signup',
    email: email.trim(),
    options: { emailRedirectTo: callbackUrl() },
  })
  if (error) throw problem(error)
}

/** Email a reset link. Says nothing about whether the address has an account. */
export async function sendPasswordReset(email: string): Promise<void> {
  const { error } = await getSupabase().auth.resetPasswordForEmail(email.trim(), {
    redirectTo: `${window.location.origin}/reset-password`,
  })
  if (error) throw problem(error)
}

/** Set a new password for the signed-in (or just-recovered) teacher. */
export async function updatePassword(password: string): Promise<void> {
  const { error } = await getSupabase().auth.updateUser({ password })
  if (error) throw problem(error)
}

/**
 * A verification or reset link that failed arrives with the reason in the URL —
 * `#error=access_denied&error_code=otp_expired&…`. Read it so the page can say "this link
 * has expired" instead of silently bouncing to the sign-in form.
 */
export function linkError(): string | null {
  const params = new URLSearchParams(
    window.location.hash.replace(/^#/, '') || window.location.search.replace(/^\?/, ''),
  )
  const code = params.get('error_code') ?? params.get('error')
  if (!code) return null
  if (code === 'otp_expired') {
    return 'This link has expired or has already been used. Ask for a new one below.'
  }
  return params.get('error_description')?.replace(/\+/g, ' ') ?? 'This link didn’t work.'
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
