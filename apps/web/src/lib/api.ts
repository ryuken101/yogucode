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
  method?: 'GET' | 'POST' | 'PATCH'
  body?: unknown
  /**
   * Skip the Authorization header. The student routes are reached by people who have no
   * Supabase session at all, and `/join/lookup` is deliberately unauthenticated — sending
   * a stale teacher token there would be noise at best.
   */
  anonymous?: boolean
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, anonymous = false } = options

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

export const api = {
  /* --- teacher: identity --------------------------------------------------------- */

  /** The only route that provisions. Called once after the magic-link callback. */
  startTeacherSession: () =>
    request<Schemas['TeacherProfileOut']>('/auth/teacher/session', { method: 'POST' }),
  me: () => request<Schemas['TeacherProfileOut']>('/auth/me'),
  centre: () => request<Schemas['CentreOut']>('/centre'),

  /* --- teacher: classes ---------------------------------------------------------- */

  listClasses: () => request<Schemas['ClassOut'][]>('/classes'),
  createClass: (body: Schemas['ClassIn']) =>
    request<Schemas['ClassDetailOut']>('/classes', { method: 'POST', body }),
  readClass: (classId: string) => request<Schemas['ClassDetailOut']>(`/classes/${classId}`),
  rotateJoinCode: (classId: string) =>
    request<Schemas['ClassDetailOut']>(`/classes/${classId}/join-code/rotate`, {
      method: 'POST',
    }),

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
  archiveDocument: (documentId: string) =>
    request<Schemas['DocumentOut']>(`/me/documents/${documentId}/archive`, {
      method: 'POST',
      anonymous: true,
    }),
}
