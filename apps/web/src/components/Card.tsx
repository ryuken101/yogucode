import type { ReactNode } from 'react'

/** A raised surface: white on cream with a hairline, per the brand book — soft borders, not shadows. */
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-3xl bg-surface p-6 ring-1 ring-line ${className}`}>
      {children}
    </section>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-3xl border-2 border-dashed border-grape/15 bg-surface/60 px-6 py-10 text-center">
      <p className="font-display font-semibold text-lg text-grape">{title}</p>
      {children ? <div className="mt-2 text-sm text-muted">{children}</div> : null}
    </div>
  )
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="font-display font-semibold text-2xl text-grape">{title}</h1>
      {children ? <div className="flex items-center gap-2">{children}</div> : null}
    </header>
  )
}
