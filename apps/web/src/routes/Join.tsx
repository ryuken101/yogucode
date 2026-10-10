/**
 * The student's way in: their username and their PIN (Ken's decision, 11 Oct 2026).
 *
 * The teacher creates each child's account and hands them a slip; the child types the two
 * things on it. There is no class code and no list of names to pick from any more — their
 * classes are found from their account.
 *
 * Every message a child can see here is `not-yet` (lemon) or `good` (mint), never the error
 * colour. A wrong PIN is "not yet", not an error — the reason the palette rule exists at
 * all. `system-error` appears only when the server could not be reached, which is genuinely
 * our fault.
 */

import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Button } from '../components/Button'
import { Card, PageHeader } from '../components/Card'
import { TextInput } from '../components/Field'
import { JoinShell } from '../components/AppShell'
import { Welcome } from '../components/Brand'
import { Notice } from '../components/Notice'
import type { Schemas } from '../lib/api'
import { api } from '../lib/api'
import { ApiError, messageFor } from '../lib/errors'
import { markStudentTab } from '../lib/tabSession'

export function Join() {
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [me, setMe] = useState<Schemas['StudentMeOut'] | null>(null)
  /** Something the child can fix: a wrong PIN, a lockout, no class yet. Always not-yet. */
  const [notYet, setNotYet] = useState<string | null>(null)
  /** Our fault: the API is unreachable. The only place system-error is allowed. */
  const [broken, setBroken] = useState<string | null>(null)

  async function signIn(event: React.FormEvent) {
    event.preventDefault()
    setNotYet(null)
    setBroken(null)
    setBusy(true)
    try {
      const signedIn = await api.studentSignIn({ username: username.trim(), pin })
      // This tab is now the child's; closing it signs them out (lib/tabSession.ts).
      markStudentTab()
      setMe(signedIn)
    } catch (error) {
      setPin('')
      if (error instanceof ApiError && error.status === 0) {
        setBroken(messageFor(error))
      } else if (error instanceof ApiError && (error.status === 429 || error.status === 403)) {
        // A lockout, or no class yet: the server's sentence says what to do.
        setNotYet(error.message)
      } else {
        setNotYet('That username and PIN don’t match. Check your slip and try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <JoinShell>
      {me ? null : <Welcome />}
      <Card>
        {me ? (
          <>
            <PageHeader title={`You’re in, ${me.display_name}`} />
            <Notice tone="good">{me.class_name}</Notice>
            <div className="mt-4 flex flex-col gap-3">
              <Button variant="primary" onClick={() => navigate('/home')}>
                Start writing Python
              </Button>
            </div>
          </>
        ) : (
          <>
            <PageHeader title="Sign in" />
            <form onSubmit={signIn} className="flex flex-col gap-4">
              <TextInput
                label="Username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
              <TextInput
                label="PIN"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
              />
              <Button
                type="submit"
                variant="primary"
                disabled={busy || username.trim() === '' || pin.length !== 4}
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          </>
        )}

        {notYet ? (
          <div className="mt-4">
            <Notice tone="not-yet">{notYet}</Notice>
          </div>
        ) : null}
        {broken ? (
          <div className="mt-4">
            <Notice tone="system-error">{broken}</Notice>
          </div>
        ) : null}
      </Card>
      {/* The site's front door is the children's: teachers come in by this side door. */}
      {me ? null : (
        <p className="mt-4 text-center text-sm text-muted">
          Teacher?{' '}
          <Link to="/sign-in" className="text-grape-deep underline">
            Sign in here
          </Link>
        </p>
      )}
    </JoinShell>
  )
}
