import type { ReactNode } from 'react'

/** A raised surface. Paper on cream, per §8 — white would be too stark for a 90-minute lesson. */
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl bg-paper p-5 ring-1 ring-ink/10 ${className}`}>
      {children}
    </section>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-ink-soft/30 bg-paper/50 px-6 py-10 text-center">
      <p className="font-serif text-lg text-ink">{title}</p>
      {children ? <div className="mt-2 text-sm text-ink-soft">{children}</div> : null}
    </div>
  )
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="font-serif text-2xl text-ink">{title}</h1>
      {children ? <div className="flex items-center gap-2">{children}</div> : null}
    </header>
  )
}
