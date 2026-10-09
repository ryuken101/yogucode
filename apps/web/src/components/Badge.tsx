/**
 * A status pill.
 *
 * The variants are semantic, not colours, and that is the point. The palette has one rule
 * that is easy to break by habit: **never red for a student's state.** `not-yet` (lemon)
 * means "not yet", `good` (mint) means good, `system-error` (raspberry) is reserved for
 * the app failing — a child's record being archived, or their PIN not being set yet, is
 * not an error and must never look like one. Strawberry, the brand accent, is never a
 * state at all.
 *
 * There is deliberately no `error` variant that a screen can reach for casually. The only
 * error colour in the app is `system-error`, and the name is long enough to make you think.
 */

type Variant = 'active' | 'muted' | 'not-yet' | 'good' | 'system-error'

const VARIANTS: Record<Variant, string> = {
  /** Enrolled, signed in, working. */
  active: 'bg-grape-pale text-grape',
  /** Archived, withdrawn. A state, not a problem. */
  muted: 'bg-cream text-muted ring-1 ring-muted/20',
  /** No PIN yet, needs attention, partially done. Lemon, never red. */
  'not-yet': 'bg-not-yet/30 text-grape ring-1 ring-not-yet',
  /** Correct, complete, passing. */
  good: 'bg-good/15 text-grape ring-1 ring-good/60',
  /** The API failed or the app broke. The only error colour in the product. */
  'system-error': 'bg-system-error/10 text-system-error ring-1 ring-system-error/30',
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
