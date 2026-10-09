/**
 * Where the "Forgot password?" email lands: choose a new password.
 *
 * supabase-js reads the recovery token from the URL on load (`detectSessionInUrl`) and
 * signs the teacher in for this purpose. So by the time this runs there is a session —
 * or the link was expired or already used, which Supabase reports in the URL and
 * `linkError()` reads, so the page can say so instead of showing a form that will fail.
 *
 * The new password is typed twice here, unlike sign-up: the teacher has just lost one
 * password and this is the moment a typo would lose them the next.
 */

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Button } from '../components/Button'
import { Card, PageHeader } from '../components/Card'
import { PasswordInput } from '../components/Field'
import { JoinShell } from '../components/AppShell'
import { Welcome } from '../components/Brand'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import {
  type AuthFailure,
  MIN_PASSWORD,
  authFailure,
  currentAccessToken,
  linkError,
  updatePassword,
} from '../lib/supabase'

export function ResetPassword() {
  const navigate = useNavigate()
  // null while checking; a string when the link is no good; true when there is a session.
  const [ready, setReady] = useState<true | string | null>(() => linkError())
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<AuthFailure | null>(null)

  useEffect(() => {
    if (ready !== null) return
    let cancelled = false
    currentAccessToken()
      .then((token) => {
        if (cancelled) return
        setReady(token ? true : 'This link has expired or has already been used. Ask for a new one below.')
      })
      .catch(() => !cancelled && setReady('This link didn’t work. Ask for a new one below.'))
    return () => {
      cancelled = true
    }
  }, [ready])

  const mismatch = again.length > 0 && again !== password

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setFailure(null)
    setBusy(true)
    try {
      await updatePassword(password)
      // Through the callback, like every sign-in: it provisions if needed, then classes.
      navigate('/auth/callback', { replace: true })
    } catch (error) {
      setFailure(authFailure(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <JoinShell>
      <Welcome />
      <Card>
        <PageHeader title="Choose a new password" />
        {ready === null ? (
          <Spinner label="Checking your link" />
        ) : ready !== true ? (
          <div className="flex flex-col gap-3">
            <Notice tone="not-yet">{ready}</Notice>
            <Link to="/sign-in" className="text-sm text-grape-deep underline">
              Back to sign in — use “Forgot password?” to get a new link
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <PasswordInput
              label="New password"
              required
              autoComplete="new-password"
              minLength={MIN_PASSWORD}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              hint={
                password.length > 0 && password.length < MIN_PASSWORD
                  ? `At least ${MIN_PASSWORD} characters.`
                  : null
              }
            />
            <PasswordInput
              label="Type it again"
              required
              autoComplete="new-password"
              value={again}
              onChange={(event) => setAgain(event.target.value)}
              hint={mismatch ? 'These don’t match yet.' : null}
            />
            {failure ? (
              <Notice tone={failure.fixable ? 'not-yet' : 'system-error'}>{failure.message}</Notice>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              disabled={busy || password.length < MIN_PASSWORD || again !== password}
            >
              {busy ? 'Saving…' : 'Save and sign in'}
            </Button>
          </form>
        )}
      </Card>
    </JoinShell>
  )
}
