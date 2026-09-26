/**
 * An inline message.
 *
 * The tone names are the §8 rule spelled out: `not-yet` for anything the person can fix,
 * `good` for success, `system-error` for the API being unreachable or broken. A wrong
 * PIN, a duplicate name, a locked-out child — all `not-yet`, all amber. Rust only when
 * the fault is ours.
 */

import type { ReactNode } from 'react'

type Tone = 'not-yet' | 'good' | 'system-error' | 'info'

const TONES: Record<Tone, string> = {
  'not-yet': 'bg-amber/10 text-ink ring-amber/40',
  good: 'bg-sage/10 text-ink ring-sage/40',
  'system-error': 'bg-rust/10 text-rust ring-rust/30',
  info: 'bg-sky-pale/40 text-ink ring-sky/30',
}

export function Notice({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <p
      role={tone === 'system-error' ? 'alert' : 'status'}
      className={`rounded-lg px-3 py-2 text-sm ring-1 ${TONES[tone]}`}
    >
      {children}
    </p>
  )
}
