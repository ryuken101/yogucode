/**
 * Where every teacher sign-in finishes: after the password form, after the verification
 * link in the sign-up email, and after choosing a new password.
 *
 * supabase-js consumes any token in the URL on load (`detectSessionInUrl`), so by the
 * time this runs there is either a session or there is not. Then it calls
 * `POST /auth/teacher/session` — the **only** route in the system that provisions a
 * `users` row and, for the first teacher, the centre itself. Everything else assumes the
 * row exists and 403s with `profile_not_provisioned` if it does not.
 *
 * Three outcomes are told apart on purpose:
 * - the link expired or was already used — Supabase says so in the URL;
 * - the API refused (not invited, or removed by the owner) — a decision someone made,
 *   which the teacher can fix by asking, so `not-yet`; and they are signed out of
 *   Supabase, so the next attempt starts clean;
 * - anything else is ours to fix: `system-error`.
 */

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Card, PageHeader } from '../components/Card'
import { JoinShell } from '../components/AppShell'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { api } from '../lib/api'
import { ApiError, messageFor } from '../lib/errors'
import { keys } from '../lib/queries'
import { currentAccessToken, linkError, signOut } from '../lib/supabase'

type Failure = { message: string; fixable: boolean }

export function AuthCallback() {
  const navigate = useNavigate()
  const client = useQueryClient()
  const [failure, setFailure] = useState<Failure | null>(() => {
    const expired = linkError()
    return expired ? { message: expired, fixable: true } : null
  })

  useEffect(() => {
    if (failure) return
    let cancelled = false

    async function run() {
      try {
        const token = await currentAccessToken()
        if (!token) {
          if (!cancelled) navigate('/sign-in', { replace: true })
          return
        }
        const profile = await api.startTeacherSession()
        if (cancelled) return
        client.setQueryData(keys.me, profile)
        navigate('/desk', { replace: true })
      } catch (error) {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 403) {
          await signOut().catch(() => undefined)
          setFailure({ message: error.message, fixable: true })
        } else {
          setFailure({ message: messageFor(error), fixable: false })
        }
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [client, navigate, failure])

  return (
    <JoinShell>
      <Card>
        <PageHeader title={failure ? 'Couldn’t sign you in' : 'Signing you in'} />
        {failure ? (
          <div className="flex flex-col gap-4">
            <Notice tone={failure.fixable ? 'not-yet' : 'system-error'}>{failure.message}</Notice>
            <Link to="/sign-in" replace className="text-sm text-grape-deep underline">
              Back to sign in
            </Link>
          </div>
        ) : (
          <Spinner label="Finishing sign-in" />
        )}
      </Card>
    </JoinShell>
  )
}
