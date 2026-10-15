/**
 * Show PIN on a roster row (Ken's decision, 16 Oct 2026): a teacher without the slip looks
 * up one child's PIN.
 *
 * Hidden until asked for, and hidden again after half a minute or a second press, so it is
 * not left on a screen a class can see. The PIN lives only in this component's state —
 * never the query cache — and every reveal is audited on the server. A PIN set before Show
 * PIN existed cannot be revealed; the row says Change PIN will fix that, in muted text,
 * because it is not a fault.
 */

import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { messageFor } from '../lib/errors'
import { useRevealPin } from '../lib/queries'

export const SHOW_PIN_SECONDS = 30

export function ShowPin({
  studentId,
  name,
  viewable,
}: {
  studentId: string
  name: string
  viewable: boolean
}) {
  const reveal = useRevealPin()
  const [pin, setPin] = useState<string | null>(null)

  useEffect(() => {
    if (pin === null) return
    const timer = setTimeout(() => setPin(null), SHOW_PIN_SECONDS * 1000)
    return () => clearTimeout(timer)
  }, [pin])

  if (!viewable) {
    return <span className="text-sm text-muted">Change PIN to make it viewable</span>
  }

  return (
    <>
      {pin !== null ? (
        <span
          className="rounded-2xl bg-cream px-3 py-1 font-mono text-base tracking-widest text-grape ring-1 ring-line"
          aria-label={`${name}’s PIN`}
        >
          {pin}
        </span>
      ) : null}
      {reveal.error ? (
        <span className="text-sm text-muted">{messageFor(reveal.error)}</span>
      ) : null}
      <Button
        variant="quiet"
        disabled={reveal.isPending}
        aria-label={pin !== null ? `Hide ${name}’s PIN` : `Show ${name}’s PIN`}
        onClick={() => {
          if (pin !== null) {
            setPin(null)
            return
          }
          reveal.mutate(studentId, { onSuccess: (slip) => setPin(slip.pin) })
        }}
      >
        {pin !== null ? 'Hide PIN' : 'Show PIN'}
      </Button>
    </>
  )
}
