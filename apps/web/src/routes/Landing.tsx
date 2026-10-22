/**
 * The site's front page.
 *
 * Since 22 Oct 2026 (Ken's decision, replacing 8 Oct's "the bare address is the student
 * sign-in") a visitor gets the public landing page (`landing/LandingPage.tsx`), with
 * **Student sign in** (→ `/join`) and Teacher sign in in its nav. Anyone already signed in
 * never sees it:
 *
 * - a child still signed in goes straight to their Today page;
 * - a teacher with a session goes to their desktop.
 *
 * The landing page is lazy-loaded, so a child being redirected never downloads it. It
 * must keep working when Supabase is unconfigured or unreachable.
 */

import { Suspense, lazy, useEffect, useState } from 'react'
import { Navigate } from 'react-router'
import { JoinShell } from '../components/AppShell'
import { Spinner } from '../components/Spinner'
import { useStudentMe } from '../lib/queries'
import { currentAccessToken, supabaseConfigured } from '../lib/supabase'

const LandingPage = lazy(() =>
  import('../landing/LandingPage').then((m) => ({ default: m.LandingPage })),
)

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
  if (teacher) return <Navigate to="/desk" replace />
  const loading = (
    <JoinShell>
      <Spinner label="Loading" />
    </JoinShell>
  )
  if (student.isPending || teacher === null) return loading
  return (
    <Suspense fallback={loading}>
      <LandingPage />
    </Suspense>
  )
}
