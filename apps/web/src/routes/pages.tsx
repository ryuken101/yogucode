/**
 * Every page, as the `<Route>`s each desktop window resolves its page against.
 *
 * Two lists because the two audiences never share a page. `App.tsx` mounts each list under
 * its guard so the router knows the URLs exist; the guard then hands the same list to the
 * desktop, which renders one page per window with `<Routes location>` (`desktop/Desktop.tsx`).
 * `/desk` (`/my-desk` for a child) is no app's page: it is where sign-in lands, and it shows
 * whatever is in front. The two lists share no path — the router would send a teacher to the
 * first guard that matched.
 */
import { Suspense, lazy } from 'react'
import { Route } from 'react-router'
import { Spinner } from '../components/Spinner'
import { ClassDetail } from './ClassDetail'
import { ClassList } from './ClassList'
import { SlipSheet } from './SlipSheet'
import { StudentHome } from './StudentHome'

/**
 * The curriculum and problem screens are teacher-only and pull in markdown rendering and
 * the editor modules — about 40 KB gzipped that `/join` must not make twelve children
 * download on centre wifi. Lazy, so the entry chunk stays what a child needs.
 */
const Curriculum = lazy(() => import('./Curriculum').then((m) => ({ default: m.Curriculum })))
const ProblemBank = lazy(() =>
  import('./ProblemBank').then((m) => ({ default: m.ProblemBank })),
)
const ProblemImport = lazy(() =>
  import('./ProblemImport').then((m) => ({ default: m.ProblemImport })),
)
const ProblemEditor = lazy(() =>
  import('./ProblemEditor').then((m) => ({ default: m.ProblemEditor })),
)

const ProblemAttempt = lazy(() =>
  import('./ProblemAttempt').then((m) => ({ default: m.ProblemAttempt })),
)

const HomeworkSheet = lazy(() =>
  import('./HomeworkSheet').then((m) => ({ default: m.HomeworkSheet })),
)

const HomeworkBuilder = lazy(() =>
  import('./HomeworkBuilder').then((m) => ({ default: m.HomeworkBuilder })),
)
const Marking = lazy(() => import('./Marking').then((m) => ({ default: m.Marking })))
const MarkingStart = lazy(() =>
  import('./Marking').then((m) => ({ default: m.MarkingStart })),
)
const Progress = lazy(() => import('./Progress').then((m) => ({ default: m.Progress })))
const StudentHistory = lazy(() =>
  import('./StudentHistory').then((m) => ({ default: m.StudentHistory })),
)

const MyCode = lazy(() => import('./MyCode').then((m) => ({ default: m.MyCode })))
const Teachers = lazy(() => import('./Teachers').then((m) => ({ default: m.Teachers })))
const Live = lazy(() => import('./Live').then((m) => ({ default: m.Live })))
// My files streams to the live view, so it carries the collaboration library; lazy, so
// `/join` does not.
const Work = lazy(() => import('./Work').then((m) => ({ default: m.Work })))

const QuizBuilder = lazy(() =>
  import('./QuizBuilder').then((m) => ({ default: m.QuizBuilder })),
)
const QuizRunner = lazy(() => import('./QuizRunner').then((m) => ({ default: m.QuizRunner })))

function Loading({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<Spinner label="Loading" />}>{children}</Suspense>
}


// The desktop's own screens (16 Oct 2026). Lazy like the rest: none of them is on `/join`.
const ClassWork = lazy(() => import('./ClassWork').then((m) => ({ default: m.ClassWork })))
const MarkingHome = lazy(() => import('./MarkingHome').then((m) => ({ default: m.MarkingHome })))
const MyWork = lazy(() => import('./MyWork').then((m) => ({ default: m.MyWork })))
const Finder = lazy(() => import('../desktop/Finder').then((m) => ({ default: m.Finder })))
const ChildFile = lazy(() => import('./ChildFile').then((m) => ({ default: m.ChildFile })))
const Trash = lazy(() => import('./Trash').then((m) => ({ default: m.Trash })))

export const studentPages = (
  <>
    <Route path="/home" element={<StudentHome />} />
    <Route path="/work" element={<Loading><Work /></Loading>} />
    <Route path="/quiz/:assignmentId" element={<Loading><QuizRunner /></Loading>} />
    <Route path="/homework/:assignmentId" element={<Loading><HomeworkSheet /></Loading>} />
    <Route
      path="/lesson/:assignmentId/:itemId"
      element={<Loading><ProblemAttempt /></Loading>}
    />
    {/* The same page for a homework or quiz question, so it opens in the Work window it was
        chosen from rather than in Lessons (23 Oct 2026). */}
    <Route
      path="/homework/:assignmentId/:itemId"
      element={<Loading><ProblemAttempt /></Loading>}
    />
    <Route path="/quiz/:assignmentId/:itemId" element={<Loading><ProblemAttempt /></Loading>} />
    <Route path="/my-work" element={<Loading><MyWork /></Loading>} />
    <Route path="/my-files" element={<Loading><Finder /></Loading>} />
    <Route path="/my-desk" element={null} />
  </>
)

export const teacherPages = (
  <>
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
    <Route path="/my-code" element={<Loading><MyCode /></Loading>} />
    <Route path="/trash" element={<Loading><Trash /></Loading>} />
    <Route path="/problems" element={<Loading><ProblemBank /></Loading>} />
    {/* One key for both: saving a new problem navigates from /new to /:itemId, and a
        remount there would drop the solution check that was running. */}
    <Route path="/problems/import" element={<Loading><ProblemImport /></Loading>} />
    <Route path="/problems/new" element={<Loading key="problem"><ProblemEditor /></Loading>} />
    <Route
      path="/problems/:itemId"
      element={<Loading key="problem"><ProblemEditor /></Loading>}
    />
    <Route path="/classes/:classId/work" element={<Loading><ClassWork /></Loading>} />
    <Route path="/classes/:classId/marking" element={<Loading><MarkingHome /></Loading>} />
    <Route path="/files" element={<Loading><Finder /></Loading>} />
    <Route path="/files/mine" element={<Loading><Finder /></Loading>} />
    <Route path="/files/students/:studentId" element={<Loading><Finder /></Loading>} />
    <Route
      path="/code/students/:studentId/:documentId"
      element={<Loading><ChildFile /></Loading>}
    />
    <Route path="/desk" element={null} />
  </>
)
