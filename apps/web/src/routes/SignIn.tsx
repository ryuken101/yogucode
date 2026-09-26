/**
 * Teacher sign-in: an email address, and a magic link.
 *
 * No password, because there are few teachers and a password is one more thing to reset.
 * The allowlist lives in the API's config, and an address that is not on it gets a link
 * that works as far as Supabase is concerned and is then refused at /auth/callback — so
 * the rejection message has to be written for that moment, not this one.
 */

import { useState } from 'react'
import { Navigate } from 'react-router'
import { Button } from '../components/Button'
import { Card, PageHeader } from '../components/Card'
import { TextInput } from '../components/Field'
import { JoinShell } from '../components/AppShell'
import { Notice } from '../components/Notice'
import { messageFor } from '../lib/errors'
import { sendMagicLink, supabaseConfigured } from '../lib/supabase'
import { useMe } from '../lib/queries'

export function SignIn() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const { data: alreadySignedIn } = useMe({ retry: false })

  if (alreadySignedIn) return <Navigate to="/classes" replace />

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setFailure(null)
    setSending(true)
    try {
      await sendMagicLink(email)
      setSent(true)
    } catch (error) {
      setFailure(messageFor(error))
    } finally {
      setSending(false)
    }
  }

  return (
    <JoinShell>
      <Card>
        <PageHeader title="Sign in" />
        {!supabaseConfigured ? (
          <Notice tone="system-error">
            Supabase is not configured yet. Set VITE_SUPABASE_URL and
            VITE_SUPABASE_ANON_KEY in apps/web/.env.local.
          </Notice>
        ) : sent ? (
          <div className="flex flex-col gap-3">
            <Notice tone="good">
              Check your email. The link signs you in on this device.
            </Notice>
            <p className="text-sm text-ink-soft">
              Nothing arrived? The free Supabase tier sends two auth emails an hour across
              the whole project, so a second attempt may need to wait.
            </p>
            <Button variant="quiet" onClick={() => setSent(false)}>
              Use a different address
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <TextInput
              label="Email address"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            {failure ? <Notice tone="system-error">{failure}</Notice> : null}
            <Button type="submit" variant="primary" disabled={sending || email.trim() === ''}>
              {sending ? 'Sending…' : 'Email me a link'}
            </Button>
          </form>
        )}
      </Card>
      <p className="mt-6 text-center text-sm text-ink-soft">
        Students don’t sign in here —{' '}
        <a href="/join" className="text-sky-deep underline">
          go to /join
        </a>
      </p>
    </JoinShell>
  )
}
