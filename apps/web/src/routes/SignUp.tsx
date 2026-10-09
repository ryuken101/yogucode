/**
 * Teacher sign-up: name, email, password, then a verification email (Ken's decisions,
 * 10 Oct 2026).
 *
 * Only invited addresses may sign up. The page asks the API first
 * (`GET /auth/signup-allowed`), so an uninvited teacher hears "ask your centre to add you"
 * before an account is made in Supabase and an email is sent for nothing. That check is a
 * courtesy, not the gate — provisioning checks again, because anyone can create a Supabase
 * account without this page.
 *
 * The verification link lands on /auth/callback, which provisions the teacher and takes
 * them to their classes.
 */

import { useState } from 'react'
import { Link } from 'react-router'
import { Button } from '../components/Button'
import { Card, PageHeader } from '../components/Card'
import { PasswordInput, TextInput } from '../components/Field'
import { JoinShell } from '../components/AppShell'
import { Welcome } from '../components/Brand'
import { Notice } from '../components/Notice'
import { api } from '../lib/api'
import { messageFor } from '../lib/errors'
import {
  type AuthFailure,
  MIN_PASSWORD,
  authFailure,
  resendVerification,
  signUp,
  supabaseConfigured,
} from '../lib/supabase'

type Stage = 'form' | 'not-invited' | 'exists' | 'sent'

export function SignUp() {
  const [stage, setStage] = useState<Stage>('form')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<AuthFailure | null>(null)
  const [resent, setResent] = useState(false)

  const short = password.length > 0 && password.length < MIN_PASSWORD

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setFailure(null)
    setBusy(true)
    try {
      let allowed: boolean
      try {
        allowed = (await api.signupAllowed(email)).allowed
      } catch (error) {
        // Our API, not Supabase: unreachable or broken, which is ours to fix.
        setFailure({ message: messageFor(error), fixable: false })
        return
      }
      if (!allowed) {
        setStage('not-invited')
        return
      }
      setStage(await signUp(name, email, password))
    } catch (error) {
      setFailure(authFailure(error))
    } finally {
      setBusy(false)
    }
  }

  async function resend() {
    setFailure(null)
    try {
      await resendVerification(email)
      setResent(true)
    } catch (error) {
      setFailure(authFailure(error))
    }
  }

  function startOver() {
    setStage('form')
    setFailure(null)
    setResent(false)
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
            <PageHeader title="Create an account" />
            <Notice tone="system-error">
              Supabase is not configured yet. Set VITE_SUPABASE_URL and
              VITE_SUPABASE_ANON_KEY in apps/web/.env.local.
            </Notice>
          </>
        ) : stage === 'sent' ? (
          <div className="flex flex-col gap-3">
            <PageHeader title="Check your email" />
            <Notice tone="good">
              We sent a link to {email.trim()}. Click it to verify your email and finish
              setting up your account.
            </Notice>
            <p className="text-sm text-muted">
              It comes from no-reply@yogucode.com. Nothing after a few minutes? Check your
              spam folder, or send it again.
            </p>
            {resent ? <Notice tone="good">Sent again.</Notice> : null}
            {failureNotice}
            <Button variant="secondary" onClick={() => void resend()} disabled={resent}>
              Resend the email
            </Button>
            <Button variant="quiet" onClick={startOver}>
              Use a different email
            </Button>
          </div>
        ) : stage === 'not-invited' ? (
          <div className="flex flex-col gap-3">
            <PageHeader title="Not invited yet" />
            <Notice tone="not-yet">
              {email.trim()} hasn’t been invited. Ask your centre’s owner to add you on their
              Teachers page, then come back here.
            </Notice>
            <Button variant="quiet" onClick={startOver}>
              Try a different email
            </Button>
          </div>
        ) : stage === 'exists' ? (
          <div className="flex flex-col gap-3">
            <PageHeader title="You already have an account" />
            <Notice tone="not-yet">
              There’s already an account for {email.trim()}. Sign in instead — or use “Forgot
              password?” there if you need a new one.
            </Notice>
            <Link
              to="/sign-in"
              className="rounded-2xl bg-grape px-4 py-2 text-center text-sm font-medium text-surface hover:bg-grape-deep"
            >
              Go to sign in
            </Link>
          </div>
        ) : (
          <>
            <PageHeader title="Create an account" />
            <form onSubmit={submit} className="flex flex-col gap-4">
              <TextInput
                label="Your name"
                required
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
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
                autoComplete="new-password"
                minLength={MIN_PASSWORD}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                hint={short ? `At least ${MIN_PASSWORD} characters.` : null}
              />
              {failureNotice}
              <Button
                type="submit"
                variant="primary"
                disabled={
                  busy ||
                  name.trim() === '' ||
                  email.trim() === '' ||
                  password.length < MIN_PASSWORD
                }
              >
                {busy ? 'Creating…' : 'Create account'}
              </Button>
            </form>
          </>
        )}
      </Card>
      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link to="/sign-in" className="text-grape-deep underline">
          Sign in
        </Link>
      </p>
    </JoinShell>
  )
}
