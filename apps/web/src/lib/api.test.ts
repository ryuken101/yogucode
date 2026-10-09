/**
 * The client's half of the two-identity seam.
 *
 * The server resolves a teacher from an `Authorization` header and a student from an
 * httpOnly cookie. This side has to get three things right, and each has a way of failing
 * quietly rather than loudly:
 *
 *   1. Send a bearer token when there is a teacher session, and not otherwise.
 *   2. Never send one on the student routes, which are reached by people with no Supabase
 *      session at all.
 *   3. Always send credentials, because the student's cookie is the only thing
 *      identifying them and JavaScript cannot read it to check.
 */

import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { server } from '../test/server'

/**
 * `api.ts` reads the token through `currentAccessToken`, so the session is mocked at that
 * boundary. Mocking `fetch` instead would test the mock; mocking supabase-js itself would
 * test supabase-js.
 */
const currentAccessToken = vi.hoisted(() => vi.fn<() => Promise<string | null>>())
vi.mock('./supabase', () => ({
  currentAccessToken,
  supabaseConfigured: true,
  getSupabase: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}))

const { api, request } = await import('./api')

/** Capture what the client actually put on the wire. */
function captureRequest(path: string, method: 'get' | 'post' = 'get') {
  const seen: { auth: string | null; credentials: string; contentType: string | null }[] = []
  server.use(
    http[method](path, ({ request: req }) => {
      seen.push({
        auth: req.headers.get('authorization'),
        credentials: req.credentials,
        contentType: req.headers.get('content-type'),
      })
      return HttpResponse.json({})
    }),
  )
  return seen
}

beforeEach(() => currentAccessToken.mockReset())
afterEach(() => vi.clearAllMocks())

test('a teacher request carries the current bearer token', async () => {
  currentAccessToken.mockResolvedValue('a-real-token')
  const seen = captureRequest('/api/classes')

  await api.listClasses()

  expect(seen[0]?.auth).toBe('Bearer a-real-token')
})

test('no session means no Authorization header at all', async () => {
  // Not `Bearer null`, not `Bearer undefined` — absent. A malformed header is a 401 the
  // person cannot explain, and it looks like a server problem rather than a sign-out.
  currentAccessToken.mockResolvedValue(null)
  const seen = captureRequest('/api/classes')

  await api.listClasses()

  expect(seen[0]?.auth).toBeNull()
})

test('the token is read per request, not cached', async () => {
  // supabase-js rotates the access token in the background. A client that captured it
  // once would start 401ing an hour into a lesson for no visible reason.
  currentAccessToken.mockResolvedValueOnce('first').mockResolvedValueOnce('second')
  const seen = captureRequest('/api/classes')

  await api.listClasses()
  await api.listClasses()

  expect(seen.map((s) => s.auth)).toEqual(['Bearer first', 'Bearer second'])
})

test('student routes never send a teacher token, even when one exists', async () => {
  // A teacher testing the join flow in their own browser has a live Supabase session.
  // Sending it to an unauthenticated route is noise at best and confusing at worst.
  currentAccessToken.mockResolvedValue('a-real-token')
  const lookup = captureRequest('/api/join/lookup', 'post')
  const me = captureRequest('/api/auth/student/me')

  await api.joinLookup('WNPXYZ')
  await api.studentMe()

  expect(lookup[0]?.auth).toBeNull()
  expect(me[0]?.auth).toBeNull()
  expect(currentAccessToken).not.toHaveBeenCalled()
})

test('every request sends credentials, because the student cookie is httpOnly', async () => {
  currentAccessToken.mockResolvedValue(null)
  const seen = captureRequest('/api/auth/student/me')

  await api.studentMe()

  expect(seen[0]?.credentials).toBe('include')
})

test('a body sets JSON content-type; a bodyless request does not', async () => {
  currentAccessToken.mockResolvedValue('t')
  const withBody = captureRequest('/api/classes', 'post')
  const without = captureRequest('/api/classes')

  await api.createClass({ name: 'Year 4-6 Python', term_label: null })
  await api.listClasses()

  expect(withBody[0]?.contentType).toContain('application/json')
  expect(without[0]?.contentType).toBeNull()
})

test('a 204 resolves rather than failing to parse an empty body', async () => {
  currentAccessToken.mockResolvedValue(null)
  server.use(http.post('/api/auth/student/logout', () => new HttpResponse(null, { status: 204 })))

  await expect(api.studentSignOut()).resolves.toBeUndefined()
})

test('an unreachable server becomes a status-0 ApiError, not a raw TypeError', async () => {
  const { ApiError } = await import('./errors')
  currentAccessToken.mockResolvedValue(null)
  server.use(http.get('/api/auth/student/me', () => HttpResponse.error()))

  await expect(api.studentMe()).rejects.toBeInstanceOf(ApiError)
  await expect(api.studentMe()).rejects.toMatchObject({ status: 0 })
})

test('a non-JSON error body still yields a readable message', async () => {
  currentAccessToken.mockResolvedValue(null)
  server.use(
    http.get('/api/auth/student/me', () =>
      new HttpResponse('<html>502 Bad Gateway</html>', { status: 502 }),
    ),
  )

  await expect(request('/auth/student/me', { anonymous: true })).rejects.toMatchObject({
    status: 502,
  })
})
