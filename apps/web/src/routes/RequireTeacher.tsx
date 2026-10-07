/**
 * The teacher route guard.
 *
 * Two gates, in order, because they fail differently. First: is there a Supabase session
 * at all? That is local and instant, and its absence means "sign in", not "you are not
 * allowed". Second: does the API recognise this teacher? That catches an address removed
 * from the allowlist and an account disabled since the token was issued — the allowlist
 * is checked on every request precisely so removing someone actually revokes them.
 *
 * `profile_not_provisioned` sends the teacher back through /auth/callback, which is the
 * only route that provisions. This guard never writes.
 */

import { useQueryClient } from '@tanstack/react-query'
import { Navigate, Outlet, useNavigate } from 'react-router'
import { AppShell } from '../components/AppShell'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { ApiError } from '../lib/errors'
import { signOut, supabaseConfigured } from '../lib/supabase'
import { useMe } from '../lib/queries'

export function RequireTeacher() {
  const navigate = useNavigate()
  const client = useQueryClient()
  const { data, isPending, error } = useMe({ retry: false })

  if (!supabaseConfigured) {
    return (
      <AppShell>
        <Notice tone="system-error">
          Supabase is not configured, so teacher sign-in is unavailable. Set
          VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in apps/web/.env.local.
        </Notice>
      </AppShell>
    )
  }

  if (isPending) {
    return (
      <AppShell>
        <Spinner label="Checking your sign-in" />
      </AppShell>
    )
  }

  if (error) {
    if (error instanceof ApiError && error.isNotProvisioned) {
      return <Navigate to="/auth/callback" replace />
    }
    if (error instanceof ApiError && error.status === 403) {
      // Verified by Supabase, refused by us: not on the allowlist, or disabled.
      return (
        <AppShell>
          <Notice tone="system-error">{error.message}</Notice>
        </AppShell>
      )
    }
    return <Navigate to="/sign-in" replace />
  }

  return (
    <AppShell
      centreName={data.centre.name}
      onSignOut={() => {
        void signOut().then(() => {
          // Forget who was signed in, or the sign-in page reads the cached profile, thinks
          // the teacher is still here, and sends them straight back to their classes.
          client.clear()
          navigate('/sign-in', { replace: true })
        })
      }}
    >
      <Outlet />
    </AppShell>
  )
}
