/**
 * The student route guard, and the thin bar above the editor.
 *
 * Mirrors `RequireTeacher`, with one difference that matters: a signed-out child is sent to
 * `/join`, not `/sign-in`. Students have no Supabase session and no magic link — sending
 * them to a teacher's sign-in page would be a dead end with an email field they cannot use.
 *
 * Without this guard `/work` was reachable by anyone. That was harmless while the editor
 * stored nothing in memory, and stops being harmless the moment it saves: every request
 * would 401 and a child would type into a page that silently discards their work.
 *
 * The bar answers "whose account is this" before a child starts typing, which on a
 * borrowed or shared laptop is the question that matters — and gives a teacher somewhere
 * obvious to press when handing the machine to the next student.
 */

import { Navigate, Outlet, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '../components/Button'
import { Spinner } from '../components/Spinner'
import { api } from '../lib/api'
import { useStudentMe } from '../lib/queries'

export function RequireStudent() {
  const navigate = useNavigate()
  const client = useQueryClient()
  const { data: me, isPending, error } = useStudentMe()

  if (isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-cream">
        <Spinner label="Signing you in" />
      </div>
    )
  }

  // Any failure is the same answer: go and sign in. A revoked session, an expired one, an
  // archived student and a stale cookie are indistinguishable to a child and have the
  // same remedy.
  if (error || !me) return <Navigate to="/join" replace />

  async function signOut() {
    await api.studentSignOut().catch(() => undefined)
    // The cached identity has to go, or the guard would wave the next child through as
    // the previous one.
    client.clear()
    navigate('/join', { replace: true })
  }

  return (
    <div className="flex h-dvh flex-col bg-cream">
      <header className="flex shrink-0 items-center justify-between border-b border-ink/10 px-4 py-2">
        <p className="text-sm text-ink">
          <span className="font-medium">{me.display_name}</span>
          <span className="text-ink-soft"> · {me.class_name}</span>
        </p>
        <Button variant="quiet" onClick={() => void signOut()}>
          Sign out
        </Button>
      </header>
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
    </div>
  )
}
