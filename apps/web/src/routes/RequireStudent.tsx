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

import { useEffect } from 'react'
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { CupMark } from '../components/Brand'
import { Button } from '../components/Button'
import { navPill } from '../components/navPill'
import { Spinner } from '../components/Spinner'
import { closeStudentLive, studentLive } from '../collab/socket'
import { api } from '../lib/api'
import { keys, useActiveQuiz, useStudentMe } from '../lib/queries'
import { clearStudentTab } from '../lib/tabSession'

export function RequireStudent() {
  const navigate = useNavigate()
  const client = useQueryClient()
  const { data: me, isPending, error } = useStudentMe()
  const activeQuiz = useActiveQuiz()
  const location = useLocation()

  // Keep the live connection open on every student page — it is how a quiz starting or
  // ending reaches this child at once, not just at the next 15-second check.
  useEffect(() => {
    if (!me) return
    return studentLive().onQuiz(() => {
      void client.invalidateQueries({ queryKey: keys.activeQuiz })
      void client.invalidateQueries({ queryKey: keys.home })
    })
  }, [me, client])

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
  if (error || !me) return <Navigate to="/" replace />

  // While the class sits a quiz, the quiz is the only place a child can be (Ken's decision).
  const quiz = activeQuiz.data
  if (quiz) {
    const allowed =
      location.pathname === `/quiz/${quiz.assignment_id}` ||
      location.pathname.startsWith(`/lesson/${quiz.assignment_id}/`)
    if (!allowed) return <Navigate to={`/quiz/${quiz.assignment_id}`} replace />
  }

  async function signOut() {
    await api.studentSignOut().catch(() => undefined)
    clearStudentTab()
    // The live connection belongs to this child; the next one on the laptop opens their own.
    closeStudentLive()
    // The cached identity has to go, or the guard would wave the next child through as
    // the previous one.
    client.clear()
    navigate('/', { replace: true })
  }

  return (
    <div className="flex h-dvh flex-col bg-cream">
      <header className="flex shrink-0 items-center justify-between border-b border-line bg-surface px-4 py-2">
        <div className="flex items-center gap-4">
          <CupMark size={28} />
          <p className="text-sm text-grape">
            <span className="font-medium">{me.display_name}</span>
            <span className="text-muted"> · {me.class_name}</span>
          </p>
          <nav className={`flex gap-1 text-sm ${quiz ? 'invisible' : ''}`}>
            {[
              ['/home', 'Today'],
              ['/work', 'My files'],
            ].map(([to, label]) => (
              <NavLink
                key={to}
                to={to}
                className={navPill}
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
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
