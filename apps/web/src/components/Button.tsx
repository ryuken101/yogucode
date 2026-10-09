/**
 * A button.
 *
 * There is no `danger` variant, on purpose. The two actions that look destructive —
 * rotating a join code and kicking a session — do not destroy anything: one issues a new
 * code, the other ends a session that can be started again. Colouring them red would
 * teach a teacher to hesitate over the two things they will do most often. Both confirm
 * in a Dialog instead, which asks the question in words.
 *
 * Nothing in this product is deleted, so nothing here needs to look like deletion.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'quiet'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-grape text-surface hover:bg-grape-deep focus-visible:outline-grape-deep',
  secondary:
    'bg-surface text-grape ring-1 ring-grape/20 hover:bg-cream focus-visible:outline-grape-deep',
  quiet: 'bg-transparent text-muted hover:text-grape hover:bg-cream focus-visible:outline-grape-deep',
}

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  children: ReactNode
}

export function Button({ variant = 'secondary', className = '', children, ...rest }: Props) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center rounded-2xl px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    >
      {children}
    </button>
  )
}
