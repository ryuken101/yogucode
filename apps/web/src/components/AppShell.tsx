/**
 * The frame a teacher sees before their desktop opens: while their sign-in is checked, or
 * when it is refused. Signed in, every teacher page is in an app window on the desktop
 * (`desktop/Desktop.tsx`, 16 Oct 2026), which has its own top bar and dock — so there is no
 * navigation here.
 */

import type { ReactNode } from 'react'
import { Lockup } from './Brand'

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-cream">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl items-center px-6 py-3 text-grape">
          <Lockup size={30} />
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
