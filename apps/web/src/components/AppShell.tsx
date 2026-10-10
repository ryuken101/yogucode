/**
 * The frame around teacher screens.
 *
 * Student screens deliberately do not use it. A child at /join should see their name and
 * their class and nothing else — no navigation into a teacher's world, no sign-out that
 * looks like it might lose their work, no centre name they have no use for.
 */

import { Link, NavLink } from 'react-router'
import type { ReactNode } from 'react'
import { Lockup } from './Brand'
import { Button } from './Button'
import { navPill } from './navPill'

interface Props {
  centreName?: string
  /** The owner also manages who teaches here. */
  isOwner?: boolean
  /**
   * Full width and full height, for pages that are an editor rather than a document — My
   * code. Everything else keeps the readable centred column.
   */
  wide?: boolean
  onSignOut?: () => void
  children: ReactNode
}

export function AppShell({
  centreName,
  isOwner = false,
  wide = false,
  onSignOut,
  children,
}: Props) {
  return (
    <div className={wide ? 'flex h-dvh flex-col bg-cream' : 'min-h-dvh bg-cream'}>
      <header className="shrink-0 border-b border-line bg-surface">
        <div
          className={`mx-auto flex items-center justify-between gap-4 px-6 py-3 ${wide ? '' : 'max-w-5xl'}`}
        >
          <div className="flex items-center gap-5">
            <Link to="/classes" className="flex items-center gap-3 text-grape">
              <Lockup size={30} />
              {centreName ? (
                <span className="hidden border-l border-line pl-3 text-sm text-muted sm:inline">
                  {centreName}
                </span>
              ) : null}
            </Link>
            <nav className="flex gap-1 text-sm">
              {[
                ['/classes', 'Classes'],
                ['/curriculum', 'Curriculum'],
                ['/problems', 'Problems'],
                ['/my-code', 'My code'],
                ...(isOwner ? [['/teachers', 'Teachers']] : []),
              ].map(([to, label]) => (
                <NavLink key={to} to={to} className={navPill}>
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
      <main className={wide ? 'min-h-0 flex-1 px-4 py-3' : 'mx-auto max-w-5xl px-6 py-8'}>
        {children}
      </main>
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
