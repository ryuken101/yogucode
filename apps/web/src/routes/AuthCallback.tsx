/**
 * Where the magic link lands.
 *
 * supabase-js consumes the token in the URL fragment on load (`detectSessionInUrl`), so
 * by the time this runs there is either a session or there is not. Then it calls
 * `POST /auth/teacher/session` — the **only** route in the system that provisions a
 * `users` row and, for the first teacher, the centre itself. Everything else assumes the
 * row exists and 403s with `profile_not_provisioned` if it does not.
 *
 * The two refusals are told apart on purpose. A non-allowlisted address is a decision
 * someone made and the teacher needs to be told plainly; anything else is ours to fix.
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Card, PageHeader } from '../components/Card'
import { JoinShell } from '../components/AppShell'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { Button } from '../components/Button'
import { api } from '../lib/api'
import { ApiError, messageFor } from '../lib/errors'
import { keys } from '../lib/queries'
import { currentAccessToken } from '../lib/supabase'

export function AuthCallback() {
  const navigate = useNavigate()
  const client = useQueryClient()
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
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
        navigate('/classes', { replace: true })
      } catch (error) {
        if (cancelled) return
        setFailure(
          error instanceof ApiError && error.status === 403
            ? error.message
            : messageFor(error),
        )
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [client, navigate])

  return (
    <JoinShell>
      <Card>
        <PageHeader title={failure ? 'Could not sign you in' : 'Signing you in'} />
        {failure ? (
          <div className="flex flex-col gap-4">
            <Notice tone="system-error">{failure}</Notice>
            <Button variant="secondary" onClick={() => navigate('/sign-in', { replace: true })}>
              Back to sign in
            </Button>
          </div>
        ) : (
          <Spinner label="Finishing sign-in" />
        )}
      </Card>
    </JoinShell>
  )
}
