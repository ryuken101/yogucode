/**
 * The route tree.
 *
 * Two audiences share one app and must not share a frame. Teacher routes sit behind
 * `RequireTeacher`, which supplies the shell; `/join` is outside it entirely, because a
 * child needs no navigation, no sign-out and no centre name — and because the join flow
 * must keep working when Supabase is unconfigured or unreachable.
 */

import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { Spinner } from './components/Spinner'
import { AuthCallback } from './routes/AuthCallback'
import { ClassDetail } from './routes/ClassDetail'
import { ClassList } from './routes/ClassList'
import { Join } from './routes/Join'
import { NotFound } from './routes/NotFound'
import { RequireTeacher } from './routes/RequireTeacher'
import { SignIn } from './routes/SignIn'
import { RequireStudent } from './routes/RequireStudent'
import { SlipSheet } from './routes/SlipSheet'
import { StudentHome } from './routes/StudentHome'
import { Work } from './routes/Work'

/**
 * The curriculum and problem screens are teacher-only and pull in markdown rendering and
 * the editor modules — about 40 KB gzipped that `/join` must not make twelve children
 * download on centre wifi. Lazy, so the entry chunk stays what a child needs.
 */
const Curriculum = lazy(() => import('./routes/Curriculum').then((m) => ({ default: m.Curriculum })))
const ProblemBank = lazy(() =>
  import('./routes/ProblemBank').then((m) => ({ default: m.ProblemBank })),
)
const ProblemImport = lazy(() =>
  import('./routes/ProblemImport').then((m) => ({ default: m.ProblemImport })),
)
const ProblemEditor = lazy(() =>
  import('./routes/ProblemEditor').then((m) => ({ default: m.ProblemEditor })),
)

const ProblemAttempt = lazy(() =>
  import('./routes/ProblemAttempt').then((m) => ({ default: m.ProblemAttempt })),
)

function Loading({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<Spinner label="Loading" />}>{children}</Suspense>
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/classes" replace />} />
      <Route path="/sign-in" element={<SignIn />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="/join" element={<Join />} />

      <Route element={<RequireStudent />}>
        <Route path="/home" element={<StudentHome />} />
        <Route path="/work" element={<Work />} />
        <Route
          path="/lesson/:assignmentId/:itemId"
          element={<Loading><ProblemAttempt /></Loading>}
        />
      </Route>

      <Route element={<RequireTeacher />}>
        <Route path="/classes" element={<ClassList />} />
        <Route path="/classes/:classId" element={<ClassDetail />} />
        <Route path="/classes/:classId/slips" element={<SlipSheet />} />
        <Route path="/curriculum" element={<Loading><Curriculum /></Loading>} />
        <Route path="/problems" element={<Loading><ProblemBank /></Loading>} />
        {/* One key for both: saving a new problem navigates from /new to /:itemId, and a
            remount there would drop the solution check that was running. */}
        <Route path="/problems/import" element={<Loading><ProblemImport /></Loading>} />
        <Route path="/problems/new" element={<Loading key="problem"><ProblemEditor /></Loading>} />
        <Route
          path="/problems/:itemId"
          element={<Loading key="problem"><ProblemEditor /></Loading>}
        />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
