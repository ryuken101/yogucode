/**
 * The route tree.
 *
 * Two audiences share one app and must not share a frame. Teacher routes sit behind
 * `RequireTeacher`, which supplies the shell; `/join` is outside it entirely, because a
 * child needs no navigation, no sign-out and no centre name — and because the join flow
 * must keep working when Supabase is unconfigured or unreachable.
 */

import { Suspense, lazy } from 'react'
import { Route, Routes } from 'react-router'
import { Spinner } from './components/Spinner'
import { AuthCallback } from './routes/AuthCallback'
import { ClassDetail } from './routes/ClassDetail'
import { ClassList } from './routes/ClassList'
import { Join } from './routes/Join'
import { Landing } from './routes/Landing'
import { NotFound } from './routes/NotFound'
import { RequireTeacher } from './routes/RequireTeacher'
import { ResetPassword } from './routes/ResetPassword'
import { SignIn } from './routes/SignIn'
import { SignUp } from './routes/SignUp'
import { RequireStudent } from './routes/RequireStudent'
import { SlipSheet } from './routes/SlipSheet'
import { StudentHome } from './routes/StudentHome'

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

const HomeworkSheet = lazy(() =>
  import('./routes/HomeworkSheet').then((m) => ({ default: m.HomeworkSheet })),
)

const HomeworkBuilder = lazy(() =>
  import('./routes/HomeworkBuilder').then((m) => ({ default: m.HomeworkBuilder })),
)
const Marking = lazy(() => import('./routes/Marking').then((m) => ({ default: m.Marking })))
const MarkingStart = lazy(() =>
  import('./routes/Marking').then((m) => ({ default: m.MarkingStart })),
)
const Progress = lazy(() => import('./routes/Progress').then((m) => ({ default: m.Progress })))
const StudentHistory = lazy(() =>
  import('./routes/StudentHistory').then((m) => ({ default: m.StudentHistory })),
)

const Teachers = lazy(() => import('./routes/Teachers').then((m) => ({ default: m.Teachers })))
const Live = lazy(() => import('./routes/Live').then((m) => ({ default: m.Live })))
// My files streams to the live view, so it carries the collaboration library; lazy, so
// `/join` does not.
const Work = lazy(() => import('./routes/Work').then((m) => ({ default: m.Work })))

const QuizBuilder = lazy(() =>
  import('./routes/QuizBuilder').then((m) => ({ default: m.QuizBuilder })),
)
const QuizRunner = lazy(() => import('./routes/QuizRunner').then((m) => ({ default: m.QuizRunner })))

function Loading({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<Spinner label="Loading" />}>{children}</Suspense>
}

export default function App() {
  return (
    <Routes>
      {/* The bare address is the children's sign-in; /join stays as an alias. */}
      <Route path="/" element={<Landing />} />
      <Route path="/sign-in" element={<SignIn />} />
      <Route path="/sign-up" element={<SignUp />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="/join" element={<Join />} />

      <Route element={<RequireStudent />}>
        <Route path="/home" element={<StudentHome />} />
        <Route path="/work" element={<Loading><Work /></Loading>} />
        <Route path="/quiz/:assignmentId" element={<Loading><QuizRunner /></Loading>} />
        <Route path="/homework/:assignmentId" element={<Loading><HomeworkSheet /></Loading>} />
        <Route
          path="/lesson/:assignmentId/:itemId"
          element={<Loading><ProblemAttempt /></Loading>}
        />
      </Route>

      <Route element={<RequireTeacher />}>
        <Route path="/classes" element={<ClassList />} />
        <Route path="/classes/:classId" element={<ClassDetail />} />
        <Route path="/classes/:classId/slips" element={<SlipSheet />} />
        <Route path="/classes/:classId/homework/new" element={<Loading><HomeworkBuilder /></Loading>} />
        <Route
          path="/classes/:classId/homework/:assignmentId"
          element={<Loading><HomeworkBuilder /></Loading>}
        />
        <Route path="/classes/:classId/quizzes/new" element={<Loading><QuizBuilder /></Loading>} />
        <Route
          path="/classes/:classId/quizzes/:quizId"
          element={<Loading><QuizBuilder /></Loading>}
        />
        <Route path="/classes/:classId/live" element={<Loading><Live /></Loading>} />
        <Route path="/classes/:classId/progress" element={<Loading><Progress /></Loading>} />
        <Route path="/assignments/:assignmentId/mark" element={<Loading><MarkingStart /></Loading>} />
        <Route
          path="/assignments/:assignmentId/mark/:itemId"
          element={<Loading><Marking /></Loading>}
        />
        <Route path="/students/:studentId" element={<Loading><StudentHistory /></Loading>} />
        <Route path="/curriculum" element={<Loading><Curriculum /></Loading>} />
        <Route path="/teachers" element={<Loading><Teachers /></Loading>} />
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
