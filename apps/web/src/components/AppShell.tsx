/**
 * The frame around teacher screens.
 *
 * Student screens deliberately do not use it. A child at /join should see their name and
 * their class and nothing else — no navigation into a teacher's world, no sign-out that
 * looks like it might lose their work, no centre name they have no use for.
 */

import { Link, NavLink } from 'react-router'
import type { ReactNode } from 'react'
import { Button } from './Button'

interface Props {
  centreName?: string
  onSignOut?: () => void
  children: ReactNode
}

export function AppShell({ centreName, onSignOut, children }: Props) {
  return (
    <div className="min-h-dvh bg-cream">
      <header className="border-b border-ink/10 bg-paper/80">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-6">
            <Link to="/classes" className="font-serif text-lg text-ink hover:text-sky-deep">
              {centreName ?? 'Coding-teaching-tool'}
            </Link>
            <nav className="flex gap-4 text-sm">
              {[
                ['/classes', 'Classes'],
                ['/curriculum', 'Curriculum'],
                ['/problems', 'Problems'],
              ].map(([to, label]) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    isActive ? 'text-sky-deep' : 'text-ink-soft hover:text-ink'
                  }
                >
                  {label}
                </NavLink>
              ))}
            </nav>
          </div>
          {onSignOut ? (
            <Button variant="quiet" onClick={onSignOut}>
              Sign out
            </Button>
          ) : null}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  )
}

/** The frame for the student flow: centred, calm, nothing to navigate to. */
export function JoinShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-cream px-6 py-10">
      <div className="w-full max-w-md">{children}</div>
    </div>
  )
}
