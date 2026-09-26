/**
 * A stand-in for the API, built from the same shapes the real one publishes.
 *
 * Handlers return `components['schemas'][...]` types, so a response model changing on the
 * server breaks these tests at compile time rather than letting them keep passing against
 * a shape the API no longer sends.
 */

import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { Schemas } from '../lib/api'

export const CLASS_ID = '018f0000-0000-7000-8000-000000000001'
export const ARIA_ID = '018f0000-0000-7000-8000-000000000002'
export const BELLA_ID = '018f0000-0000-7000-8000-000000000003'
export const CODE = 'WNPXYZ'
export const ARIA_PIN = '4827'

const lookup: Schemas['JoinLookupOut'] = {
  class_id: CLASS_ID,
  class_name: 'Year 4-6 Python',
  term_label: '2026 T4',
  students: [
    { id: ARIA_ID, display_name: 'Aria K', has_pin: true },
    { id: BELLA_ID, display_name: 'Bella N', has_pin: false },
  ],
}

const signedIn: Schemas['StudentMeOut'] = {
  student_id: ARIA_ID,
  display_name: 'Aria K',
  class_id: CLASS_ID,
  class_name: 'Year 4-6 Python',
  term_label: '2026 T4',
}

/** Matches the API: a wrong PIN, an unknown id and a foreign child all fail alike. */
const WRONG = { detail: 'that name and PIN do not match' }

export const handlers = [
  http.post('/api/join/lookup', async ({ request }) => {
    const body = (await request.json()) as Schemas['JoinLookupIn']
    if (body.code.trim().toUpperCase() !== CODE) {
      return HttpResponse.json({ detail: 'class code not found' }, { status: 404 })
    }
    return HttpResponse.json(lookup)
  }),

  http.post('/api/auth/student/session', async ({ request }) => {
    const body = (await request.json()) as Schemas['StudentSignInIn']
    if (body.pin !== ARIA_PIN) return HttpResponse.json(WRONG, { status: 401 })
    return HttpResponse.json(signedIn)
  }),
]

export const server = setupServer(...handlers)

/** A locked-out student, for the 429 path. */
export function lockedOut() {
  return http.post('/api/auth/student/session', () =>
    HttpResponse.json(
      { detail: 'too many wrong tries — ask your teacher, or try again in 15 minutes' },
      { status: 429 },
    ),
  )
}

/** The API unreachable, which is the only case allowed to show rust. */
export function unreachable() {
  return http.post('/api/join/lookup', () => HttpResponse.error())
}
