/**
 * Teacher sign-in: email and password (Ken's decision, 10 Oct 2026; it replaced the
 * magic link).
 *
 * Two modes on one page: signing in, and "Forgot password?", which emails a reset link to
 * /reset-password. A successful sign-in goes through /auth/callback, which is the one
 * place that provisions — so the first sign-in after verifying and every one after it
 * take the same path.
 *
 * The palette rule applies to auth like anything else. A wrong password or an unverified
 * email is something the teacher can fix: `not-yet`. Only Supabase being unreachable is
 * `system-error`.
 */

import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router'
import { Button } from '../components/Button'
import { Card, PageHeader } from '../components/Card'
import { PasswordInput, TextInput } from '../components/Field'
import { JoinShell } from '../components/AppShell'
import { Welcome } from '../components/Brand'
import { Notice } from '../components/Notice'
import {
  type AuthFailure,
  authFailure,
  sendPasswordReset,
  signIn,
  supabaseConfigured,
} from '../lib/supabase'
import { useMe } from '../lib/queries'

export function SignIn() {
  const navigate = useNavigate()
  const [mode, setMode] = useState<'sign-in' | 'forgot'>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<AuthFailure | null>(null)
  const [resetSent, setResetSent] = useState(false)
  const { data: alreadySignedIn } = useMe({ retry: false })

  if (alreadySignedIn) return <Navigate to="/desk" replace />

  async function submitSignIn(event: React.FormEvent) {
    event.preventDefault()
    setFailure(null)
    setBusy(true)
    try {
      await signIn(email, password)
      navigate('/auth/callback', { replace: true })
    } catch (error) {
      setFailure(authFailure(error))
    } finally {
      setBusy(false)
    }
  }

  async function submitForgot(event: React.FormEvent) {
    event.preventDefault()
    setFailure(null)
    setBusy(true)
    try {
      await sendPasswordReset(email)
      setResetSent(true)
    } catch (error) {
      setFailure(authFailure(error))
    } finally {
      setBusy(false)
    }
  }

  function switchTo(next: 'sign-in' | 'forgot') {
    setMode(next)
    setFailure(null)
    setResetSent(false)
  }

  const failureNotice = failure ? (
    <Notice tone={failure.fixable ? 'not-yet' : 'system-error'}>{failure.message}</Notice>
  ) : null

  return (
    <JoinShell>
      <Welcome />
      <Card>
        {!supabaseConfigured ? (
          <>
            <PageHeader title="Sign in" />
            <Notice tone="system-error">
              Supabase is not configured yet. Set VITE_SUPABASE_URL and
              VITE_SUPABASE_ANON_KEY in apps/web/.env.local.
            </Notice>
          </>
        ) : mode === 'sign-in' ? (
          <>
            <PageHeader title="Sign in" />
            <form onSubmit={submitSignIn} className="flex flex-col gap-4">
              <TextInput
                label="Email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <PasswordInput
                label="Password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              {failureNotice}
              <Button
                type="submit"
                variant="primary"
                disabled={busy || email.trim() === '' || password === ''}
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
              <Button type="button" variant="quiet" onClick={() => switchTo('forgot')}>
                Forgot password?
              </Button>
            </form>
          </>
        ) : (
          <>
            <PageHeader title="Reset your password" />
            {resetSent ? (
              <div className="flex flex-col gap-3">
                <Notice tone="good">
                  If there’s an account for {email.trim()}, a reset link is on its way. It comes
                  from no-reply@yogucode.com — check your spam folder if it doesn’t arrive.
                </Notice>
                <Button variant="quiet" onClick={() => switchTo('sign-in')}>
                  Back to sign in
                </Button>
              </div>
            ) : (
              <form onSubmit={submitForgot} className="flex flex-col gap-4">
                <p className="text-sm text-muted">
                  Type your email and we’ll send you a link to choose a new password.
                </p>
                <TextInput
                  label="Email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
                {failureNotice}
                <Button type="submit" variant="primary" disabled={busy || email.trim() === ''}>
                  {busy ? 'Sending…' : 'Email me a reset link'}
                </Button>
                <Button type="button" variant="quiet" onClick={() => switchTo('sign-in')}>
                  Back to sign in
                </Button>
              </form>
            )}
          </>
        )}
      </Card>
      <p className="mt-6 text-center text-sm text-muted">
        New teacher?{' '}
        <Link to="/sign-up" className="text-grape-deep underline">
          Create an account
        </Link>
      </p>
      <p className="mt-2 text-center text-sm text-muted">
        Students don’t sign in here —{' '}
        <a href="/" className="text-grape-deep underline">
          go to the front page
        </a>
      </p>
    </JoinShell>
  )
}
