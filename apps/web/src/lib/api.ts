/**
 * The HTTP client. Every call to our API goes through `request`.
 *
 * Two identity models arrive here, exactly as they do on the server. A teacher carries a
 * Supabase JWT in an Authorization header; a student carries an httpOnly cookie this API
 * issued and which JavaScript cannot read. So requests always send credentials, and
 * attach a bearer token only when there is a teacher session — a request with both is
 * fine, because the server checks the header first and the cookie only if there is none.
 *
 * The base URL is the Vite proxy prefix in development, which is why the API has no CORS
 * middleware: one origin in the browser means no preflight and no cookie negotiation. At
 * step 10 it becomes the deployed API's origin and CORS becomes real.
 */

import { ApiError, toApiError } from './errors'
import { currentAccessToken } from './supabase'
import type { components } from './api-types'

export type Schemas = components['schemas']

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api'

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT'
  body?: unknown
  /**
   * Skip the Authorization header. The student routes are reached by people who have no
   * Supabase session at all, and `/join/lookup` is deliberately unauthenticated — sending
   * a stale teacher token there would be noise at best.
   */
  anonymous?: boolean
  /** Let the request outlive the page — for the event recorder's flush on `pagehide`. */
  keepalive?: boolean
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, anonymous = false, keepalive = false } = options

  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (!anonymous) {
    const token = await currentAccessToken()
    if (token) headers.Authorization = `Bearer ${token}`
  }

  let response: Response
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      // The student session cookie. Harmless for teacher requests, and required for
      // every student one.
      credentials: 'include',
      keepalive,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    // A dropped connection or a dead API. Status 0 marks "never reached the server",
    // which the UI treats as a system error rather than as something the person did.
    throw new ApiError(0, 'Could not reach the server. Check your connection.')
  }

  if (response.status === 204) return undefined as T

  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }

  if (!response.ok) {
    throw toApiError(response.status, parsed, response.statusText || 'Request failed')
  }
  return parsed as T
}

export interface ProblemFilters {
  statuses?: Schemas['ItemStatus'][]
  conceptId?: string
  difficulty?: number
  q?: string
}

export const api = {
  /* --- teacher: identity --------------------------------------------------------- */

  /** The only route that provisions. Called after a teacher's first verified sign-in. */
  startTeacherSession: () =>
    request<Schemas['TeacherProfileOut']>('/auth/teacher/session', { method: 'POST' }),
  me: () => request<Schemas['TeacherProfileOut']>('/auth/me'),
  centre: () => request<Schemas['CentreOut']>('/centre'),
  /**
   * Has this address been invited? Asked before creating a Supabase account, so an
   * uninvited teacher hears "ask your centre" instead of verifying an email for nothing.
   */
  signupAllowed: (email: string) =>
    request<Schemas['SignupAllowedOut']>(
      `/auth/signup-allowed?email=${encodeURIComponent(email.trim())}`,
      { anonymous: true },
    ),

  /* --- owner: the Teachers page --------------------------------------------------- */

  listTeachers: () => request<Schemas['TeachersOut']>('/teachers'),
  inviteTeacher: (email: string) =>
    request<Schemas['InviteOut']>('/teachers/invites', { method: 'POST', body: { email } }),
  revokeInvite: (inviteId: string) =>
    request<void>(`/teachers/invites/${inviteId}/revoke`, { method: 'POST' }),
  removeTeacher: (userId: string) =>
    request<void>(`/teachers/${userId}/remove`, { method: 'POST' }),

  /* --- teacher: classes ---------------------------------------------------------- */

  listClasses: () => request<Schemas['ClassOut'][]>('/classes'),
  createClass: (body: Schemas['ClassIn']) =>
    request<Schemas['ClassDetailOut']>('/classes', { method: 'POST', body }),
  readClass: (classId: string) => request<Schemas['ClassDetailOut']>(`/classes/${classId}`),
  rotateJoinCode: (classId: string) =>
    request<Schemas['ClassDetailOut']>(`/classes/${classId}/join-code/rotate`, {
      method: 'POST',
    }),

  setClassCurriculum: (classId: string, body: Schemas['ClassCurriculumIn']) =>
    request<Schemas['ClassOut']>(`/classes/${classId}/curriculum`, { method: 'PUT', body }),

  /* --- teacher: curriculum ------------------------------------------------------- */

  listConcepts: () => request<Schemas['ConceptOut'][]>('/concepts'),
  listCourses: () => request<Schemas['CourseOut'][]>('/courses'),
  readCourse: (courseId: string) => request<Schemas['CourseTreeOut']>(`/courses/${courseId}`),
  createCourse: (title: string) =>
    request<Schemas['CourseTreeOut']>('/courses', {
      method: 'POST',
      body: { title } satisfies Schemas['TitleIn'],
    }),
  renameCourse: (courseId: string, title: string) =>
    request<Schemas['CourseOut']>(`/courses/${courseId}`, {
      method: 'PATCH',
      body: { title } satisfies Schemas['TitleIn'],
    }),
  archiveCourse: (courseId: string) =>
    request<Schemas['CourseOut']>(`/courses/${courseId}/archive`, { method: 'POST' }),
  createUnit: (courseId: string, title: string) =>
    request<Schemas['UnitOut']>(`/courses/${courseId}/units`, {
      method: 'POST',
      body: { title } satisfies Schemas['TitleIn'],
    }),
  updateUnit: (unitId: string, body: Schemas['NodePatch']) =>
    request<Schemas['UnitOut']>(`/units/${unitId}`, { method: 'PATCH', body }),
  archiveUnit: (unitId: string) =>
    request<Schemas['UnitOut']>(`/units/${unitId}/archive`, { method: 'POST' }),
  createLesson: (unitId: string, title: string) =>
    request<Schemas['LessonOut']>(`/units/${unitId}/lessons`, {
      method: 'POST',
      body: { title } satisfies Schemas['TitleIn'],
    }),
  updateLesson: (lessonId: string, body: Schemas['NodePatch']) =>
    request<Schemas['LessonOut']>(`/lessons/${lessonId}`, { method: 'PATCH', body }),
  archiveLesson: (lessonId: string) =>
    request<Schemas['LessonOut']>(`/lessons/${lessonId}/archive`, { method: 'POST' }),
  setLessonConcepts: (lessonId: string, conceptIds: string[]) =>
    request<Schemas['LessonOut']>(`/lessons/${lessonId}/concepts`, {
      method: 'PUT',
      body: { concept_ids: conceptIds } satisfies Schemas['LessonConceptsIn'],
    }),

  readLadder: (lessonId: string) =>
    request<Schemas['LadderItemOut'][]>(`/lessons/${lessonId}/ladder`),
  saveLadder: (lessonId: string, itemIds: string[]) =>
    request<Schemas['LadderItemOut'][]>(`/lessons/${lessonId}/ladder`, {
      method: 'PUT',
      body: { item_ids: itemIds } satisfies Schemas['LadderIn'],
    }),

  /* --- teacher: homework, marking, progress --------------------------------------- */

  listHomework: (classId: string) =>
    request<Schemas['HomeworkOut'][]>(`/classes/${classId}/homework`),
  readHomework: (assignmentId: string) =>
    request<Schemas['HomeworkOut']>(`/assignments/${assignmentId}`),
  createHomework: (classId: string, body: Schemas['HomeworkIn']) =>
    request<Schemas['HomeworkOut']>(`/classes/${classId}/homework`, { method: 'POST', body }),
  updateHomework: (assignmentId: string, body: Schemas['HomeworkPatch']) =>
    request<Schemas['HomeworkOut']>(`/assignments/${assignmentId}`, { method: 'PATCH', body }),
  setHomework: (assignmentId: string) =>
    request<Schemas['HomeworkOut']>(`/assignments/${assignmentId}/set`, { method: 'POST' }),
  closeHomework: (assignmentId: string) =>
    request<Schemas['HomeworkOut']>(`/assignments/${assignmentId}/close`, { method: 'POST' }),
  reopenHomework: (assignmentId: string) =>
    request<Schemas['HomeworkOut']>(`/assignments/${assignmentId}/reopen`, { method: 'POST' }),
  markingOverview: (assignmentId: string) =>
    request<Schemas['MarkingOverviewOut']>(`/assignments/${assignmentId}/marking`),
  markingQuestion: (assignmentId: string, itemId: string) =>
    request<Schemas['QuestionMarkingOut']>(`/assignments/${assignmentId}/marking/${itemId}`),
  autoMark: (assignmentId: string, itemId: string) =>
    request<Schemas['AutoMarkOut']>(`/assignments/${assignmentId}/marking/${itemId}/auto`, {
      method: 'POST',
    }),
  saveMark: (attemptId: string, body: Schemas['MarkIn']) =>
    request<Schemas['MarkOut']>(`/attempts/${attemptId}/mark`, { method: 'PUT', body }),
  saveNote: (assignmentId: string, studentId: string, note: string) =>
    request<Schemas['NoteIn']>(`/assignments/${assignmentId}/notes/${studentId}`, {
      method: 'PUT',
      body: { note } satisfies Schemas['NoteIn'],
    }),
  releaseHomework: (assignmentId: string) =>
    request<Schemas['ReleaseOut']>(`/assignments/${assignmentId}/release`, { method: 'POST' }),
  listSnippets: (q?: string) =>
    request<Schemas['SnippetOut'][]>(`/snippets${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  createSnippet: (body: Schemas['SnippetIn']) =>
    request<Schemas['SnippetOut']>('/snippets', { method: 'POST', body }),
  homeworkGrid: (assignmentId: string) =>
    request<Schemas['GridOut']>(`/assignments/${assignmentId}/grid`),
  todayGrid: (classId: string) => request<Schemas['GridOut']>(`/classes/${classId}/today`),
  studentHistory: (studentId: string) =>
    request<Schemas['StudentHistoryOut']>(`/students/${studentId}/history`),

  /* --- teacher: quizzes ------------------------------------------------------------ */

  listQuizzes: (classId: string) => request<Schemas['QuizOut'][]>(`/classes/${classId}/quizzes`),
  readQuiz: (quizId: string) => request<Schemas['QuizOut']>(`/quizzes/${quizId}`),
  createQuiz: (classId: string, body: Schemas['QuizIn']) =>
    request<Schemas['QuizOut']>(`/classes/${classId}/quizzes`, { method: 'POST', body }),
  updateQuiz: (quizId: string, body: Schemas['QuizPatch']) =>
    request<Schemas['QuizOut']>(`/quizzes/${quizId}`, { method: 'PATCH', body }),
  startQuiz: (quizId: string) =>
    request<Schemas['QuizOut']>(`/quizzes/${quizId}/start`, { method: 'POST' }),
  stopQuiz: (quizId: string) =>
    request<Schemas['QuizOut']>(`/quizzes/${quizId}/stop`, { method: 'POST' }),

  /* --- teacher: problem bank ----------------------------------------------------- */

  listProblems: (filters: ProblemFilters = {}) => {
    const params = new URLSearchParams()
    for (const status of filters.statuses ?? []) params.append('status', status)
    if (filters.conceptId) params.set('concept_id', filters.conceptId)
    if (filters.difficulty) params.set('difficulty', String(filters.difficulty))
    if (filters.q) params.set('q', filters.q)
    const query = params.toString()
    return request<Schemas['ProblemSummaryOut'][]>(`/items${query ? `?${query}` : ''}`)
  },
  importProblems: (yaml: string, apply: boolean) =>
    request<Schemas['ImportReportOut']>('/items/import', {
      method: 'POST',
      body: { yaml, apply } satisfies Schemas['ImportIn'],
    }),
  readProblem: (itemId: string) => request<Schemas['ProblemOut']>(`/items/${itemId}`),
  createProblem: (body: Schemas['ProblemDoc']) =>
    request<Schemas['ProblemOut']>('/items', { method: 'POST', body }),
  saveProblem: (itemId: string, body: Schemas['ProblemDoc']) =>
    request<Schemas['ProblemOut']>(`/items/${itemId}`, { method: 'PUT', body }),
  publishProblem: (itemId: string, verifiedUpdatedAt: string) =>
    request<Schemas['ProblemOut']>(`/items/${itemId}/publish`, {
      method: 'POST',
      body: { verified_updated_at: verifiedUpdatedAt } satisfies Schemas['PublishIn'],
    }),
  newProblemVersion: (itemId: string) =>
    request<Schemas['ProblemOut']>(`/items/${itemId}/new-version`, { method: 'POST' }),
  archiveProblem: (itemId: string) =>
    request<Schemas['ProblemOut']>(`/items/${itemId}/archive`, { method: 'POST' }),
  unarchiveProblem: (itemId: string) =>
    request<Schemas['ProblemOut']>(`/items/${itemId}/unarchive`, { method: 'POST' }),

  /* --- teacher: roster ----------------------------------------------------------- */

  readRoster: (classId: string) =>
    request<Schemas['RosterEntryOut'][]>(`/classes/${classId}/roster`),
  previewPaste: (classId: string, names: string) =>
    request<Schemas['RosterPreviewOut']>(`/classes/${classId}/roster/preview`, {
      method: 'POST',
      body: { names } satisfies Schemas['PastedNamesIn'],
    }),
  commitPaste: (classId: string, entries: Schemas['BulkEntryIn'][]) =>
    request<Schemas['RosterEntryOut'][]>(`/classes/${classId}/roster/bulk`, {
      method: 'POST',
      body: { entries } satisfies Schemas['BulkEnrolIn'],
    }),
  renameStudent: (studentId: string, displayName: string) =>
    request<Schemas['StudentOut']>(`/students/${studentId}`, {
      method: 'PATCH',
      body: { display_name: displayName } satisfies Schemas['StudentPatch'],
    }),

  /* --- teacher: PINs and sessions ------------------------------------------------ */

  issuePins: (classId: string, resetExisting: boolean) =>
    request<Schemas['PinSlipOut'][]>(`/classes/${classId}/pins`, {
      method: 'POST',
      body: { reset_existing: resetExisting } satisfies Schemas['IssuePinsIn'],
    }),
  resetPin: (studentId: string) =>
    request<Schemas['PinSlipOut']>(`/students/${studentId}/pin/reset`, { method: 'POST' }),
  revokeSessions: (studentId: string) =>
    request<Schemas['SessionsRevokedOut']>(`/students/${studentId}/sessions/revoke`, {
      method: 'POST',
    }),

  /* --- student ------------------------------------------------------------------- */

  joinLookup: (code: string) =>
    request<Schemas['JoinLookupOut']>('/join/lookup', {
      method: 'POST',
      body: { code } satisfies Schemas['JoinLookupIn'],
      anonymous: true,
    }),
  studentSignIn: (body: Schemas['StudentSignInIn']) =>
    request<Schemas['StudentMeOut']>('/auth/student/session', {
      method: 'POST',
      body,
      anonymous: true,
    }),
  studentMe: () => request<Schemas['StudentMeOut']>('/auth/student/me', { anonymous: true }),
  studentSignOut: () =>
    request<void>('/auth/student/logout', { method: 'POST', anonymous: true }),

  /* --- student: their own files ---------------------------------------------------
   *
   * `anonymous: true` throughout, like the rest of the student routes: identity comes
   * from the httpOnly session cookie, and a teacher's bearer token has no business being
   * sent to a route that would refuse it anyway.
   */

  listDocuments: () =>
    request<Schemas['DocumentSummaryOut'][]>('/me/documents', { anonymous: true }),
  readDocument: (documentId: string) =>
    request<Schemas['DocumentOut']>(`/me/documents/${documentId}`, { anonymous: true }),
  createDocument: (body: Schemas['DocumentIn'] = { title: null, content: null }) =>
    request<Schemas['DocumentOut']>('/me/documents', {
      method: 'POST',
      body,
      anonymous: true,
    }),
  saveDocument: (documentId: string, body: Schemas['DocumentPatch']) =>
    request<Schemas['DocumentOut']>(`/me/documents/${documentId}`, {
      method: 'PATCH',
      body,
      anonymous: true,
    }),
  /* --- student: classwork ---------------------------------------------------------- */

  today: () => request<Schemas['TodayOut']>('/me/lesson', { anonymous: true }),
  home: () => request<Schemas['HomeOut']>('/me/home', { anonymous: true }),
  activeQuiz: () => request<Schemas['ActiveQuizOut'] | null>('/me/quiz', { anonymous: true }),
  sheet: (assignmentId: string) =>
    request<Schemas['SheetOut']>(`/me/homework/${assignmentId}`, { anonymous: true }),
  handIn: (assignmentId: string, results: Schemas['HandInResult'][]) =>
    request<Schemas['SheetOut']>(`/me/homework/${assignmentId}/hand-in`, {
      method: 'POST',
      body: { results } satisfies Schemas['HandInIn'],
      anonymous: true,
    }),
  openProblem: (assignmentId: string, itemId: string) =>
    request<Schemas['StudentProblemOut']>(
      `/me/assignments/${assignmentId}/items/${itemId}/open`,
      { method: 'POST', anonymous: true },
    ),
  saveAttempt: (attemptId: string, code: string) =>
    request<Schemas['AttemptOut']>(`/me/attempts/${attemptId}`, {
      method: 'PATCH',
      body: { code } satisfies Schemas['AttemptSaveIn'],
      anonymous: true,
    }),
  choose: (attemptId: string, choice: number) =>
    request<Schemas['AttemptOut']>(`/me/attempts/${attemptId}/choice`, {
      method: 'PUT',
      body: { choice } satisfies Schemas['ChoiceIn'],
      anonymous: true,
    }),
  recordRun: (attemptId: string, result: Schemas['RunIn'] = {}) =>
    request<Schemas['AttemptOut']>(`/me/attempts/${attemptId}/runs`, {
      method: 'POST',
      body: result,
      anonymous: true,
    }),
  unlockHint: (attemptId: string) =>
    request<Schemas['StudentLeafOut']>(`/me/attempts/${attemptId}/hints`, {
      method: 'POST',
      anonymous: true,
    }),

  recordEvents: (events: Schemas['EventIn'][], keepalive = false) =>
    request<Schemas['EventBatchOut']>('/me/events', {
      method: 'POST',
      body: { events } satisfies Schemas['EventBatchIn'],
      anonymous: true,
      keepalive,
    }),

  archiveDocument: (documentId: string) =>
    request<Schemas['DocumentOut']>(`/me/documents/${documentId}/archive`, {
      method: 'POST',
      anonymous: true,
    }),
}
