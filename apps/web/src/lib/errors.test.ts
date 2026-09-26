/**
 * The four shapes `detail` takes in this API.
 *
 * Each one is real and came from a different design decision, so each is worth a test:
 * getting the narrowing wrong shows a teacher `[object Object]` at the moment something
 * has already gone wrong.
 */

import { expect, test } from 'vitest'
import { ApiError, NOT_PROVISIONED, messageFor, toApiError } from './errors'

test('a plain string detail becomes the message', () => {
  const error = toApiError(404, { detail: 'class not found' }, 'fallback')
  expect(error.message).toBe('class not found')
  expect(error.status).toBe(404)
})

test('a coded 403 is recognised as "you have never signed in here"', () => {
  const error = toApiError(
    403,
    { detail: { code: NOT_PROVISIONED, message: 'no profile for this account yet' } },
    'fallback',
  )
  expect(error.isNotProvisioned).toBe(true)
  expect(error.message).toBe('no profile for this account yet')
})

test('an ordinary 403 is not mistaken for a missing profile', () => {
  const error = toApiError(403, { detail: 'this address is not permitted to sign in' }, 'f')
  expect(error.isNotProvisioned).toBe(false)
})

test("FastAPI's validation array surfaces the first message", () => {
  const error = toApiError(
    422,
    { detail: [{ loc: ['body', 'name'], msg: 'String should have at least 1 character', type: 'x' }] },
    'fallback',
  )
  expect(error.message).toContain('at least 1 character')
  expect(error.issues).toHaveLength(1)
})

test('the bulk-paste 422 keeps the rows that need fixing', () => {
  const error = toApiError(
    422,
    {
      detail: {
        message: 'nothing was added — fix these entries and submit again',
        entries: [{ index: 2, action: 'duplicate_in_paste', reason: 'Aria K appears twice' }],
      },
    },
    'fallback',
  )
  expect(error.message).toContain('nothing was added')
  expect(error.entries?.[0]?.index).toBe(2)
})

test('a body that is not JSON at all still produces a usable error', () => {
  const error = toApiError(502, undefined, 'Bad Gateway')
  expect(error.message).toBe('Bad Gateway')
  expect(error.status).toBe(502)
})

test('a 429 is flagged as a lockout rather than a generic failure', () => {
  expect(toApiError(429, { detail: 'too many wrong tries' }, 'f').isLockedOut).toBe(true)
})

test('a 401 is flagged as unauthenticated', () => {
  expect(toApiError(401, { detail: 'not signed in' }, 'f').isUnauthenticated).toBe(true)
})

test('messageFor never shows a person a bare status code', () => {
  expect(messageFor(new ApiError(500, 'Server error'))).toBe('Server error')
  expect(messageFor(new Error('boom'))).toBe('boom')
  expect(messageFor('something odd')).toBe('Something went wrong. Please try again.')
})
