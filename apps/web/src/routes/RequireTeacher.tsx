/**
 * The teacher route guard.
 *
 * Two gates, in order, because they fail differently. First: is there a Supabase session
 * at all? That is local and instant, and its absence means "sign in", not "you are not
 * allowed". Second: does the API recognise this teacher? That catches a teacher the owner
 * has removed since the token was issued — the account is checked on every request
 * precisely so removing someone actually revokes them.
 *
 * `profile_not_provisioned` sends the teacher back through /auth/callback, which is the
 * only route that provisions. This guard never writes.
 *
 * Signed in, the teacher gets the desktop (`desktop/Desktop.tsx`), which shows every
 * teacher page in an app window.
 */

import { useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { AppShell } from '../components/AppShell'
import { TeacherDesktop } from '../desktop/Desktop'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { ApiError } from '../lib/errors'
import { signOut, supabaseConfigured } from '../lib/supabase'
import { useMe } from '../lib/queries'
import { teacherPages } from './pages'

/** `pages` is for tests, which give a guard stand-in pages; the app uses the real list. */
export function RequireTeacher({ pages = teacherPages }: { pages?: ReactNode }) {
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
      // Verified by Supabase, refused by us: removed by the owner. A decision someone
      // made, which the teacher can ask about — not a fault.
      return (
        <AppShell>
          <Notice tone="not-yet">{error.message}</Notice>
        </AppShell>
      )
    }
    return <Navigate to="/sign-in" replace />
  }

  return (
    <TeacherDesktop
      pages={pages}
      name={data.display_name || data.email}
      subtitle={data.centre.name}
      isOwner={data.role === 'owner'}
      onSignOut={() => {
        void signOut().then(() => {
          // Forget who was signed in, or the sign-in page reads the cached profile, thinks
          // the teacher is still here, and sends them straight back to their desktop.
          client.clear()
          navigate('/sign-in', { replace: true })
        })
      }}
    />
  )
}
