/**
 * The student's way in: a class code, their name, their PIN.
 *
 * **One route, steps in state — the code never enters the URL.** The API takes it in a
 * POST body for the same reason: a class code in a query string ends up in browser
 * history on a shared centre laptop, in proxy logs, and in the Referer header of
 * whatever loads next.
 *
 * Every message a child can see here is amber or sage, never rust. A wrong PIN is "not
 * yet", not an error — product-spec §8, and the reason the palette exists at all. Rust
 * appears only when the server could not be reached, which is genuinely our fault.
 */

import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '../components/Button'
import { Card, PageHeader } from '../components/Card'
import { TextInput } from '../components/Field'
import { JoinShell } from '../components/AppShell'
import { Notice } from '../components/Notice'
import type { Schemas } from '../lib/api'
import { api } from '../lib/api'
import { ApiError, messageFor } from '../lib/errors'

type Step =
  | { name: 'code' }
  | { name: 'pick'; lookup: Schemas['JoinLookupOut'] }
  | { name: 'pin'; lookup: Schemas['JoinLookupOut']; student: Schemas['JoinStudentOut'] }
  | { name: 'in'; me: Schemas['StudentMeOut'] }

export function Join() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>({ name: 'code' })
  const [code, setCode] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  /** Something the child can fix: a wrong code, a wrong PIN, a lockout. Always amber. */
  const [notYet, setNotYet] = useState<string | null>(null)
  /** Our fault: the API is unreachable. The only place rust is allowed. */
  const [broken, setBroken] = useState<string | null>(null)

  function fail(error: unknown, notYetMessage: string) {
    if (error instanceof ApiError && error.status === 0) {
      setBroken(messageFor(error))
      return
    }
    if (error instanceof ApiError && error.isLockedOut) {
      setNotYet(error.message)
      return
    }
    setNotYet(notYetMessage)
  }

  async function findClass(event: React.FormEvent) {
    event.preventDefault()
    setNotYet(null)
    setBroken(null)
    setBusy(true)
    try {
      const lookup = await api.joinLookup(code)
      setStep({ name: 'pick', lookup })
    } catch (error) {
      fail(error, 'We couldn’t find that code. Check it and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function signIn(event: React.FormEvent) {
    event.preventDefault()
    if (step.name !== 'pin') return
    setNotYet(null)
    setBroken(null)
    setBusy(true)
    try {
      const me = await api.studentSignIn({
        code,
        student_id: step.student.id,
        pin,
      })
      setStep({ name: 'in', me })
    } catch (error) {
      setPin('')
      fail(error, 'Not quite — try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <JoinShell>
      <Card>
        {step.name === 'code' ? (
          <>
            <PageHeader title="Join your class" />
            <form onSubmit={findClass} className="flex flex-col gap-4">
              <TextInput
                label="Class code"
                required
                autoFocus
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                className="w-full rounded-lg bg-paper px-3 py-3 text-center font-mono text-2xl tracking-[0.35em] text-ink ring-1 ring-ink/15 focus:outline-2 focus:outline-sky"
              />
              <Button type="submit" variant="primary" disabled={busy || !code.trim()}>
                {busy ? 'Looking…' : 'Next'}
              </Button>
            </form>
          </>
        ) : null}

        {step.name === 'pick' ? (
          <>
            <PageHeader title="Who are you?" />
            <p className="mb-4 text-sm text-ink-soft">{step.lookup.class_name}</p>
            <ul className="flex flex-col gap-2">
              {step.lookup.students.map((student) => (
                <li key={student.id}>
                  <button
                    type="button"
                    disabled={!student.has_pin}
                    onClick={() => {
                      setNotYet(null)
                      setStep({ name: 'pin', lookup: step.lookup, student })
                    }}
                    className="w-full rounded-xl bg-paper px-4 py-4 text-left text-lg text-ink ring-1 ring-ink/15 hover:ring-sky disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:ring-ink/15"
                  >
                    {student.display_name}
                    {!student.has_pin ? (
                      <span className="mt-1 block text-sm text-amber">
                        Your teacher hasn’t set your PIN yet
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-4">
              <Button variant="quiet" onClick={() => setStep({ name: 'code' })}>
                Different class
              </Button>
            </div>
          </>
        ) : null}

        {step.name === 'pin' ? (
          <>
            <PageHeader title={`Hi ${step.student.display_name}`} />
            <form onSubmit={signIn} className="flex flex-col gap-4">
              <TextInput
                label="Your 4-digit PIN"
                required
                autoFocus
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={4}
                autoComplete="off"
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
                className="w-full rounded-lg bg-paper px-3 py-3 text-center font-mono text-3xl tracking-[0.5em] text-ink ring-1 ring-ink/15 focus:outline-2 focus:outline-sky"
              />
              <Button type="submit" variant="primary" disabled={busy || pin.length < 4}>
                {busy ? 'Checking…' : 'Start'}
              </Button>
              <Button
                variant="quiet"
                type="button"
                onClick={() => {
                  setPin('')
                  setNotYet(null)
                  setStep({ name: 'pick', lookup: step.lookup })
                }}
              >
                Not me
              </Button>
            </form>
          </>
        ) : null}

        {step.name === 'in' ? (
          <>
            <PageHeader title={`You’re in, ${step.me.display_name}`} />
            <Notice tone="good">{step.me.class_name}</Notice>
            <div className="mt-4 flex flex-col gap-3">
              <Button variant="primary" onClick={() => navigate('/home')}>
                Start writing Python
              </Button>
              <p className="text-sm text-ink-soft">
                You can close this and come back — you’ll still be signed in, and your work
                will be where you left it.
              </p>
            </div>
          </>
        ) : null}

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
    </JoinShell>
  )
}
