/**
 * Server state, through TanStack Query.
 *
 * The key scheme mirrors the API's own resources, so invalidation reads as the sentence
 * it is: renaming a student invalidates that class's roster, rotating a code invalidates
 * that class. Anything that fans out wider than that is a sign the key is wrong.
 *
 * Retries are off for 4xx. A 401, a 404 or a 409 will not become a different answer by
 * being asked again, and retrying them just delays the message a teacher is waiting for.
 */

import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query'
import { api, type ProblemFilters, type Schemas } from './api'
import { ApiError } from './errors'
import { isStudentTab } from './tabSession'

export const keys = {
  me: ['me'] as const,
  teachers: ['teachers'] as const,
  teacherDocuments: ['teacher-documents'] as const,
  teacherDocument: (documentId: string) => ['teacher-document', documentId] as const,
  classes: ['classes'] as const,
  /** Under `classes`, so invalidating the list refreshes this too. */
  classesWithArchived: ['classes', 'all'] as const,
  class: (classId: string) => ['class', classId] as const,
  roster: (classId: string) => ['roster', classId] as const,
  /** Under `roster`, so invalidating the roster refreshes this too. */
  rosterWithWithdrawn: (classId: string) => ['roster', classId, 'all'] as const,
  classTeachers: (classId: string) => ['class-teachers', classId] as const,
  studentMe: ['student-me'] as const,
  documents: ['documents'] as const,
  document: (documentId: string) => ['document', documentId] as const,
  concepts: ['concepts'] as const,
  courses: ['courses'] as const,
  course: (courseId: string) => ['course', courseId] as const,
  problems: (filters: ProblemFilters) => ['problems', filters] as const,
  allProblems: ['problems'] as const,
  problem: (itemId: string) => ['problem', itemId] as const,
  ladder: (lessonId: string) => ['ladder', lessonId] as const,
  today: ['today'] as const,
  home: ['home'] as const,
  activeQuiz: ['active-quiz'] as const,
  quizzes: (classId: string) => ['quizzes', classId] as const,
  quiz: (quizId: string) => ['quiz', quizId] as const,
  sheet: (assignmentId: string) => ['sheet', assignmentId] as const,
  homework: (classId: string) => ['homework', classId] as const,
  homeworkOne: (assignmentId: string) => ['homework-one', assignmentId] as const,
  marking: (assignmentId: string) => ['marking', assignmentId] as const,
  markingQuestion: (assignmentId: string, itemId: string) =>
    ['marking', assignmentId, itemId] as const,
  snippets: ['snippets'] as const,
  grid: (assignmentId: string) => ['grid', assignmentId] as const,
  todayGrid: (classId: string) => ['today-grid', classId] as const,
  history: (studentId: string) => ['history', studentId] as const,
  studentProblem: (assignmentId: string, itemId: string) =>
    ['student-problem', assignmentId, itemId] as const,
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          // Only retry things that might genuinely be transient: a network failure
          // (status 0) or a server fault. Never a 4xx.
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false
          return failureCount < 2
        },
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  })
}

/* --- teacher ---------------------------------------------------------------------- */

export function useMe(options?: Partial<UseQueryOptions<Schemas['TeacherProfileOut'], Error>>) {
  return useQuery({ queryKey: keys.me, queryFn: api.me, ...options })
}

export function useClasses() {
  return useQuery({ queryKey: keys.classes, queryFn: () => api.listClasses() })
}

/** Every class, removed ones included — for "Show removed classes". */
export function useClassesWithArchived(enabled: boolean) {
  return useQuery({
    queryKey: keys.classesWithArchived,
    queryFn: () => api.listClasses(true),
    enabled,
  })
}

/** Remove (archive) or put back a class. Refreshes the list and the class itself. */
export function useArchiveClass() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ classId, archive }: { classId: string; archive: boolean }) =>
      archive ? api.archiveClass(classId) : api.unarchiveClass(classId),
    onSuccess: (_result, { classId }) => {
      void client.invalidateQueries({ queryKey: keys.classes })
      void client.invalidateQueries({ queryKey: keys.class(classId) })
      void client.invalidateQueries({ queryKey: keys.roster(classId) })
    },
  })
}

export function useClass(classId: string) {
  return useQuery({ queryKey: keys.class(classId), queryFn: () => api.readClass(classId) })
}

export function useRoster(classId: string) {
  return useQuery({ queryKey: keys.roster(classId), queryFn: () => api.readRoster(classId) })
}

/** Everyone ever in the class, removed ones included — for "Show removed students". */
export function useRosterWithWithdrawn(classId: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.rosterWithWithdrawn(classId),
    queryFn: () => api.readRoster(classId, true),
    enabled,
  })
}

export function useWithdrawStudent(classId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (studentId: string) => api.withdrawStudent(classId, studentId),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.roster(classId) }),
  })
}

export function useReinstateStudent(classId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (studentId: string) => api.reinstateStudent(classId, studentId),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.roster(classId) }),
  })
}

export function useClassTeachers(classId: string) {
  return useQuery({ queryKey: keys.classTeachers(classId), queryFn: () => api.classTeachers(classId) })
}

export function useClassTeacherCandidates(classId: string) {
  return useQuery({
    queryKey: [...keys.classTeachers(classId), 'candidates'],
    queryFn: () => api.classTeacherCandidates(classId),
  })
}

/** Add, re-role or remove a class teacher. Refreshes the box and "My classes". */
export function useClassTeacherMutation<T>(
  classId: string,
  mutationFn: (arg: T) => Promise<Schemas['ClassTeacherOut'][]>,
) {
  const client = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.classTeachers(classId) })
      void client.invalidateQueries({ queryKey: keys.classes })
      void client.invalidateQueries({ queryKey: keys.class(classId) })
    },
  })
}

export function useCreateClass() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: Schemas['ClassIn']) => api.createClass(body),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.classes }),
  })
}

export function useRotateJoinCode(classId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api.rotateJoinCode(classId),
    onSuccess: (updated) => client.setQueryData(keys.class(classId), updated),
  })
}

export function useCommitPaste(classId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (entries: Schemas['BulkEntryIn'][]) => api.commitPaste(classId, entries),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.roster(classId) }),
  })
}

export function useIssuePins(classId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (resetExisting: boolean) => api.issuePins(classId, resetExisting),
    // Issuing a PIN changes `has_pin` on the join picker, not the roster shape — but the
    // roster is where the teacher sees who still needs one.
    onSuccess: () => client.invalidateQueries({ queryKey: keys.roster(classId) }),
  })
}

export function useResetPin(classId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (studentId: string) => api.resetPin(studentId),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.roster(classId) }),
  })
}

export function useRevokeSessions() {
  return useMutation({ mutationFn: (studentId: string) => api.revokeSessions(studentId) })
}

export function useRenameStudent(classId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ studentId, name }: { studentId: string; name: string }) =>
      api.renameStudent(studentId, name),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.roster(classId) }),
  })
}

/* --- owner: teachers ---------------------------------------------------------------- */

export function useTeachers() {
  return useQuery({ queryKey: keys.teachers, queryFn: api.listTeachers, retry: false })
}

function useTeachersMutation<T, R>(mutationFn: (arg: T) => Promise<R>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: () => client.invalidateQueries({ queryKey: keys.teachers }),
  })
}

export const useInviteTeacher = () => useTeachersMutation(api.inviteTeacher)
export const useRevokeInvite = () => useTeachersMutation(api.revokeInvite)
export const useRemoveTeacher = () => useTeachersMutation(api.removeTeacher)

/* --- student: identity and files ---------------------------------------------------- */

/**
 * Who the signed-in student is. Drives the guard and the shell.
 *
 * A session that this tab did not sign in (the child closed their tab, or opened a second
 * one) is ended on the server and reported as "not signed in", so every student page sends
 * them to sign in again — Ken's rule that closing the app means signing in next time. See
 * `lib/tabSession.ts`.
 */
export function useStudentMe() {
  return useQuery({
    queryKey: keys.studentMe,
    queryFn: async () => {
      const me = await api.studentMe()
      if (!isStudentTab()) {
        await api.studentSignOut().catch(() => undefined)
        throw new ApiError(401, 'Signed out because the tab was closed.')
      }
      return me
    },
    retry: false,
  })
}

/** The tab strip: newest-edited first, which is what `list_student_documents` returns. */
export function useDocuments() {
  return useQuery({ queryKey: keys.documents, queryFn: api.listDocuments })
}

/**
 * One file, with its content.
 *
 * `staleTime: Infinity` because the editor becomes the source of truth the moment it is
 * mounted. Refetching would hand a child back a version of their own file from before
 * their last few keystrokes.
 */
export function useDocument(documentId: string | null) {
  return useQuery({
    queryKey: keys.document(documentId ?? 'none'),
    queryFn: () => api.readDocument(documentId as string),
    enabled: documentId !== null,
    staleTime: Infinity,
  })
}

export function useCreateDocument() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api.createDocument(),
    onSuccess: (created) => {
      client.setQueryData(keys.document(created.id), created)
      return client.invalidateQueries({ queryKey: keys.documents })
    },
  })
}

/**
 * Save, called by the autosave debounce.
 *
 * The tab strip is **not** invalidated on every save. It is ordered by `updated_at`, so
 * refetching it mid-typing would reshuffle the tabs under a child's cursor — and the only
 * thing that actually changed is the file they are already looking at.
 */
export function useSaveDocument() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ documentId, content }: { documentId: string; content: string }) =>
      api.saveDocument(documentId, { title: null, content }),
    onSuccess: (saved) => client.setQueryData(keys.document(saved.id), saved),
  })
}

export function useRenameDocument() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ documentId, title }: { documentId: string; title: string }) =>
      api.saveDocument(documentId, { title, content: null }),
    onSuccess: (saved) => {
      client.setQueryData(keys.document(saved.id), saved)
      return client.invalidateQueries({ queryKey: keys.documents })
    },
  })
}

export function useArchiveDocument() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (documentId: string) => api.archiveDocument(documentId),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.documents }),
  })
}

/* --- teacher: My code ---------------------------------------------------------------- */
// The same behaviour as a child's files above (no refetch under the editor, no tab
// reshuffle on save), under their own keys so the two can never mix in the cache.

export function useTeacherDocuments() {
  return useQuery({ queryKey: keys.teacherDocuments, queryFn: api.listTeacherDocuments })
}

export function useTeacherDocument(documentId: string | null) {
  return useQuery({
    queryKey: keys.teacherDocument(documentId ?? 'none'),
    queryFn: () => api.readTeacherDocument(documentId as string),
    enabled: documentId !== null,
    staleTime: Infinity,
  })
}

export function useCreateTeacherDocument() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api.createTeacherDocument(),
    onSuccess: (created) => {
      client.setQueryData(keys.teacherDocument(created.id), created)
      return client.invalidateQueries({ queryKey: keys.teacherDocuments })
    },
  })
}

export function useSaveTeacherDocument() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ documentId, content }: { documentId: string; content: string }) =>
      api.saveTeacherDocument(documentId, { title: null, content }),
    onSuccess: (saved) => client.setQueryData(keys.teacherDocument(saved.id), saved),
  })
}

export function useRenameTeacherDocument() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ documentId, title }: { documentId: string; title: string }) =>
      api.saveTeacherDocument(documentId, { title, content: null }),
    onSuccess: (saved) => {
      client.setQueryData(keys.teacherDocument(saved.id), saved)
      return client.invalidateQueries({ queryKey: keys.teacherDocuments })
    },
  })
}

export function useArchiveTeacherDocument() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (documentId: string) => api.archiveTeacherDocument(documentId),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.teacherDocuments }),
  })
}

/* --- teacher: curriculum ------------------------------------------------------------ */

export function useConcepts() {
  // The taxonomy changes by YAML seed, not in a session; no reason to refetch it.
  return useQuery({ queryKey: keys.concepts, queryFn: api.listConcepts, staleTime: Infinity })
}

export function useCourses() {
  return useQuery({ queryKey: keys.courses, queryFn: api.listCourses })
}

export function useCourse(courseId: string | null) {
  return useQuery({
    queryKey: keys.course(courseId ?? ''),
    queryFn: () => api.readCourse(courseId ?? ''),
    enabled: Boolean(courseId),
  })
}

export function useCreateCourse() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (title: string) => api.createCourse(title),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.courses }),
  })
}

/**
 * Every edit inside a course's outline — units, lessons, their concepts — invalidates that
 * one course. The outline is read whole, so there is no narrower key to aim at.
 */
export function useCourseEdit<T>(courseId: string, mutationFn: (input: T) => Promise<unknown>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: () => client.invalidateQueries({ queryKey: keys.course(courseId) }),
  })
}

export function useSetClassCurriculum(classId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: Schemas['ClassCurriculumIn']) => api.setClassCurriculum(classId, body),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.class(classId) }),
  })
}

/* --- teacher: problem bank ---------------------------------------------------------- */

export function useProblems(filters: ProblemFilters) {
  return useQuery({ queryKey: keys.problems(filters), queryFn: () => api.listProblems(filters) })
}

export function useProblem(itemId: string | null) {
  return useQuery({
    queryKey: keys.problem(itemId ?? ''),
    queryFn: () => api.readProblem(itemId ?? ''),
    enabled: Boolean(itemId),
  })
}

/**
 * A mutation that returns the problem as it now stands. The answer is written straight
 * into that problem's cache entry — it *is* the fresh read — and every bank list is
 * invalidated, since any list might be filtered on what just changed.
 */
export function useProblemMutation<T>(mutationFn: (input: T) => Promise<Schemas['ProblemOut']>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: (problem) => {
      client.setQueryData(keys.problem(problem.id), problem)
      return client.invalidateQueries({ queryKey: keys.allProblems })
    },
  })
}

export function useLadder(lessonId: string | null) {
  return useQuery({
    queryKey: keys.ladder(lessonId ?? ''),
    queryFn: () => api.readLadder(lessonId ?? ''),
    enabled: Boolean(lessonId),
  })
}

export function useSaveLadder(lessonId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (itemIds: string[]) => api.saveLadder(lessonId, itemIds),
    onSuccess: (ladder) => client.setQueryData(keys.ladder(lessonId), ladder),
  })
}

/* --- student: classwork ------------------------------------------------------------ */

export function useToday() {
  return useQuery({ queryKey: keys.today, queryFn: api.today })
}

/**
 * A problem as the child sees it. The request is a POST — the first open creates the
 * attempts — but it is idempotent, so it is safe to treat as a read.
 *
 * Never refetched in the background: the editor is uncontrolled and owns the code once
 * open, and a refetch would hand it a stale copy of what the child is typing.
 */
export function useStudentProblem(assignmentId: string, itemId: string) {
  return useQuery({
    queryKey: keys.studentProblem(assignmentId, itemId),
    queryFn: () => api.openProblem(assignmentId, itemId),
    staleTime: Infinity,
  })
}

/* --- homework ------------------------------------------------------------------------ */

export function useHome() {
  return useQuery({ queryKey: keys.home, queryFn: api.home })
}

export function useSheet(assignmentId: string) {
  return useQuery({ queryKey: keys.sheet(assignmentId), queryFn: () => api.sheet(assignmentId) })
}

export function useClassHomework(classId: string) {
  return useQuery({ queryKey: keys.homework(classId), queryFn: () => api.listHomework(classId) })
}

export function useHomework(assignmentId: string | null) {
  return useQuery({
    queryKey: keys.homeworkOne(assignmentId ?? ''),
    queryFn: () => api.readHomework(assignmentId ?? ''),
    enabled: Boolean(assignmentId),
  })
}

/** A change to one homework: refresh it and its class's list. */
export function useHomeworkMutation<T>(
  classId: string,
  mutationFn: (input: T) => Promise<Schemas['HomeworkOut']>,
) {
  const client = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: (homework) => {
      client.setQueryData(keys.homeworkOne(homework.id), homework)
      return client.invalidateQueries({ queryKey: keys.homework(classId) })
    },
  })
}

export function useMarkingOverview(assignmentId: string) {
  return useQuery({
    queryKey: keys.marking(assignmentId),
    queryFn: () => api.markingOverview(assignmentId),
  })
}

/**
 * One question's answers. Not refetched behind the teacher's back: the marking screen
 * holds unsaved rubric state per child, and a refetch mid-mark would fight it.
 */
export function useMarkingQuestion(assignmentId: string, itemId: string) {
  return useQuery({
    queryKey: keys.markingQuestion(assignmentId, itemId),
    queryFn: () => api.markingQuestion(assignmentId, itemId),
    staleTime: Infinity,
  })
}

export function useSnippets() {
  return useQuery({ queryKey: keys.snippets, queryFn: () => api.listSnippets() })
}

export function useHomeworkGrid(assignmentId: string) {
  return useQuery({ queryKey: keys.grid(assignmentId), queryFn: () => api.homeworkGrid(assignmentId) })
}

export function useTodayGrid(classId: string) {
  return useQuery({ queryKey: keys.todayGrid(classId), queryFn: () => api.todayGrid(classId) })
}

export function useStudentHistory(studentId: string) {
  return useQuery({ queryKey: keys.history(studentId), queryFn: () => api.studentHistory(studentId) })
}

/* --- quizzes ------------------------------------------------------------------------ */

export function useClassQuizzes(classId: string) {
  return useQuery({ queryKey: keys.quizzes(classId), queryFn: () => api.listQuizzes(classId) })
}

export function useQuiz(quizId: string | null) {
  return useQuery({
    queryKey: keys.quiz(quizId ?? ''),
    queryFn: () => api.readQuiz(quizId ?? ''),
    enabled: Boolean(quizId),
  })
}

/** A change to one quiz: refresh it and its class's list. */
export function useQuizMutation<T>(
  classId: string,
  mutationFn: (input: T) => Promise<Schemas['QuizOut']>,
) {
  const client = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: (quiz) => {
      client.setQueryData(keys.quiz(quiz.id), quiz)
      return client.invalidateQueries({ queryKey: keys.quizzes(classId) })
    },
  })
}

/**
 * The quiz this child's class is sitting, or null. Checked every 15 seconds as a safety
 * net; the live connection's push (`quiz_started`, `quiz_ended`) is what makes it prompt.
 */
export function useActiveQuiz() {
  return useQuery({
    queryKey: keys.activeQuiz,
    queryFn: api.activeQuiz,
    refetchInterval: 15_000,
    staleTime: 0,
  })
}
