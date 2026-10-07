/**
 * The site's front page — the address a child types (Ken's decision, 8 Oct 2026).
 *
 * Children are told one thing: "go to <the site>". So the bare address is the student
 * sign-in, and it is smart about who is already here:
 *
 * - a child still signed in goes straight to their Today page;
 * - a teacher with a session goes to their classes;
 * - anyone else gets the class code → name → PIN flow, with a side door for teachers.
 *
 * The class code is still typed rather than carried in the link: one address for every
 * class, and no code in the browser history of a shared laptop (see `Join.tsx`).
 *
 * Nothing heavy is imported here. This is the page twelve children open at once on centre
 * wifi, and it must keep working when Supabase is unconfigured or unreachable.
 */

import { useEffect, useState } from 'react'
import { Navigate } from 'react-router'
import { JoinShell } from '../components/AppShell'
import { Spinner } from '../components/Spinner'
import { useStudentMe } from '../lib/queries'
import { currentAccessToken, supabaseConfigured } from '../lib/supabase'
import { Join } from './Join'

export function Landing() {
  const student = useStudentMe()
  // null = still asking Supabase; false = no teacher session. Without Supabase there is
  // nothing to ask, so the answer is "no" straight away.
  const [teacher, setTeacher] = useState<boolean | null>(supabaseConfigured ? null : false)

  useEffect(() => {
    if (!supabaseConfigured) return
    let cancelled = false
    currentAccessToken()
      .then((token) => !cancelled && setTeacher(Boolean(token)))
      .catch(() => !cancelled && setTeacher(false))
    return () => {
      cancelled = true
    }
  }, [])

  if (student.data) return <Navigate to="/home" replace />
  if (teacher) return <Navigate to="/classes" replace />
  if (student.isPending || teacher === null) {
    return (
      <JoinShell>
        <Spinner label="Loading" />
      </JoinShell>
    )
  }
  return <Join />
}
