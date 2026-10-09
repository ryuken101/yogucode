/**
 * An inline message.
 *
 * The tone names are the palette rule spelled out: `not-yet` (lemon) for anything the
 * person can fix, `good` (mint) for success, `system-error` (raspberry) for the API being
 * unreachable or broken. A wrong PIN, a duplicate name, a locked-out child — all
 * `not-yet`. The error colour only when the fault is ours.
 */

import type { ReactNode } from 'react'

type Tone = 'not-yet' | 'good' | 'system-error' | 'info'

const TONES: Record<Tone, string> = {
  'not-yet': 'bg-not-yet/20 text-grape ring-not-yet',
  good: 'bg-good/10 text-grape ring-good/60',
  'system-error': 'bg-system-error/10 text-system-error ring-system-error/30',
  info: 'bg-grape-pale/40 text-grape ring-grape/20',
}

export function Notice({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <p
      role={tone === 'system-error' ? 'alert' : 'status'}
      className={`rounded-2xl px-4 py-2.5 text-sm ring-1 ${TONES[tone]}`}
    >
      {children}
    </p>
  )
}
