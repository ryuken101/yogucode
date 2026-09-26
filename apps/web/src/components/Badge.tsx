/**
 * A status pill.
 *
 * The variants are semantic, not colours, and that is the point. product-spec §8 has one
 * rule that is easy to break by habit: **never red for a student's state.** Amber means
 * "not yet", sage means good, rust is reserved for system errors — a child's record being
 * archived, or their PIN not being set yet, is not an error and must never look like one.
 *
 * There is deliberately no `error` variant that a screen can reach for casually. The only
 * rust in the app is `system-error`, and the name is long enough to make you think.
 */

type Variant = 'active' | 'muted' | 'not-yet' | 'good' | 'system-error'

const VARIANTS: Record<Variant, string> = {
  /** Enrolled, signed in, working. */
  active: 'bg-sky-pale text-ink',
  /** Archived, withdrawn. A state, not a problem. */
  muted: 'bg-cream text-ink-soft ring-1 ring-ink-soft/20',
  /** No PIN yet, needs attention, partially done. Amber, never red. */
  'not-yet': 'bg-amber/15 text-ink ring-1 ring-amber/40',
  /** Correct, complete, passing. */
  good: 'bg-sage/15 text-ink ring-1 ring-sage/40',
  /** The API failed or the app broke. The only rust in the product. */
  'system-error': 'bg-rust/10 text-rust ring-1 ring-rust/30',
}

export function Badge({ variant, children }: { variant: Variant; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${VARIANTS[variant]}`}
    >
      {children}
    </span>
  )
}
