/**
 * A stand-in for the API, built from the same shapes the real one publishes.
 *
 * Handlers return `components['schemas'][...]` types, so a response model changing on the
 * server breaks these tests at compile time rather than letting them keep passing against
 * a shape the API no longer sends.
 */

import { http, HttpResponse, ws } from 'msw'
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

/* --- teacher-side fixtures ---------------------------------------------------------- */

export const AIDEN_ONE = '018f0000-0000-7000-8000-000000000010'
export const AIDEN_TWO = '018f0000-0000-7000-8000-000000000011'

const classDetail: Schemas['ClassDetailOut'] = {
  id: CLASS_ID,
  name: 'Year 4-6 Python',
  term_label: '2026 T4',
  status: 'active',
  course_id: null,
  current_lesson_id: null,
  join_code: CODE,
  created_at: '2026-09-27T00:00:00Z',
  updated_at: '2026-09-27T00:00:00Z',
}

/**
 * One preview row per verdict, so the dialog's six-way branch is exercised in full.
 * The order matters to the test: it asserts the rows line up with these.
 */
const preview: Schemas['RosterPreviewOut'] = {
  truncated: false,
  entries: [
    {
      line: 1,
      raw: 'Chen W',
      display_name: 'Chen W',
      action: 'create',
      student_id: null,
      student_status: null,
      candidates: [],
      reason: null,
    },
    {
      line: 2,
      raw: 'Bella N',
      display_name: 'Bella N',
      action: 'enrol_existing',
      student_id: BELLA_ID,
      student_status: 'active',
      candidates: [],
      reason: null,
    },
    {
      line: 3,
      raw: 'Aria K',
      display_name: 'Aria K',
      action: 'already_enrolled',
      student_id: ARIA_ID,
      student_status: 'active',
      candidates: [],
      reason: null,
    },
    {
      line: 4,
      raw: 'Aiden C',
      display_name: 'Aiden C',
      action: 'ambiguous',
      student_id: null,
      student_status: null,
      candidates: [
        { student_id: AIDEN_ONE, display_name: 'Aiden C', status: 'active' },
        { student_id: AIDEN_TWO, display_name: 'Aiden C', status: 'archived' },
      ],
      reason: '2 students at this centre have this name',
    },
    {
      line: 5,
      raw: 'chen w',
      display_name: 'chen w',
      action: 'duplicate_in_paste',
      student_id: null,
      student_status: null,
      candidates: [],
      reason: 'the same name appears earlier in this list',
    },
    {
      line: 6,
      raw: 'x'.repeat(90),
      display_name: 'x'.repeat(90),
      action: 'invalid',
      student_id: null,
      student_status: null,
      candidates: [],
      reason: 'longer than 80 characters',
    },
  ],
}

/* --- a student's own files ----------------------------------------------------------- */

export const DOC_ID = '018f0000-0000-7000-8000-000000000020'
export const OTHER_DOC_ID = '018f0000-0000-7000-8000-000000000021'

const documents: Record<string, Schemas['DocumentOut']> = {
  [DOC_ID]: {
    id: DOC_ID,
    title: 'spiral',
    content: 'print("spiral")\n',
    status: 'active',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
  },
  [OTHER_DOC_ID]: {
    id: OTHER_DOC_ID,
    title: 'squares',
    content: 'print("squares")\n',
    status: 'active',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  },
}

/** Newest-edited first, exactly as `list_student_documents` orders it. */
function summaries(): Schemas['DocumentSummaryOut'][] {
  return Object.values(documents)
    .map(({ content: _content, ...summary }) => summary)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

/**
 * The live classroom's sockets (`src/collab/socket.ts`). Accepted and left quiet by
 * default; tests about live behaviour add their own handler.
 */
export const liveSockets = ws.link('*/api/live/*')

export const handlers = [
  liveSockets.addEventListener('connection', () => {}),
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

  http.get('/api/classes', () => HttpResponse.json([] satisfies Schemas['ClassOut'][])),

  http.post('/api/classes', async ({ request }) => {
    const body = (await request.json()) as Schemas['ClassIn']
    return HttpResponse.json(
      { ...classDetail, name: body.name, term_label: body.term_label ?? null },
      { status: 201 },
    )
  }),

  http.post(`/api/classes/${CLASS_ID}/roster/preview`, () => HttpResponse.json(preview)),

  http.post(`/api/classes/${CLASS_ID}/roster/bulk`, () =>
    HttpResponse.json([] satisfies Schemas['RosterEntryOut'][], { status: 201 }),
  ),

  http.get(`/api/classes/${CLASS_ID}/roster`, () =>
    HttpResponse.json([] satisfies Schemas['RosterEntryOut'][]),
  ),

  http.get('/api/auth/student/me', () => HttpResponse.json(signedIn)),
  http.post('/api/auth/student/logout', () => new HttpResponse(null, { status: 204 })),

  // The event recorder flushes on a timer from any editor screen; accept and forget.
  http.post('/api/me/events', () => HttpResponse.json({ received: 0 }, { status: 202 })),

  // No quiz running unless a test says so.
  http.get('/api/me/quiz', () => HttpResponse.json(null)),

  http.get('/api/me/documents', () => HttpResponse.json(summaries())),
  http.get('/api/me/documents/:id', ({ params }) => {
    const found = documents[params.id as string]
    return found
      ? HttpResponse.json(found)
      : HttpResponse.json({ detail: 'document not found' }, { status: 404 })
  }),
  http.patch('/api/me/documents/:id', async ({ params, request }) => {
    const body = (await request.json()) as Schemas['DocumentPatch']
    const found = documents[params.id as string]!
    if (body.content !== null && body.content !== undefined) found.content = body.content
    if (body.title) found.title = body.title
    return HttpResponse.json(found)
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

/** The API unreachable, which is the only case allowed to show system-error. */
export function unreachable() {
  return http.post('/api/join/lookup', () => HttpResponse.error())
}

/** A paste with nothing to resolve, so the commit path is actually reachable. */
export function cleanPreview() {
  return http.post(`/api/classes/${CLASS_ID}/roster/preview`, () =>
    HttpResponse.json({
      truncated: false,
      entries: [
        {
          line: 1,
          raw: 'Chen W',
          display_name: 'Chen W',
          action: 'create',
          student_id: null,
          student_status: null,
          candidates: [],
          reason: null,
        },
        {
          line: 2,
          raw: 'Dara P',
          display_name: 'Dara P',
          action: 'create',
          student_id: null,
          student_status: null,
          candidates: [],
          reason: null,
        },
      ],
    } satisfies Schemas['RosterPreviewOut']),
  )
}

/** Counts commits, so a test can prove the preview step writes nothing. */
export function countCommits() {
  const calls: Schemas['BulkEnrolIn'][] = []
  const handler = http.post(`/api/classes/${CLASS_ID}/roster/bulk`, async ({ request }) => {
    calls.push((await request.json()) as Schemas['BulkEnrolIn'])
    return HttpResponse.json([] satisfies Schemas['RosterEntryOut'][], { status: 201 })
  })
  return { calls, handler }
}

/** A class list with one class in it, for the non-empty case. */
export function oneClass() {
  return http.get('/api/classes', () =>
    HttpResponse.json([
      {
        id: CLASS_ID,
        name: 'Year 4-6 Python',
        term_label: '2026 T4',
        status: 'active',
        course_id: null,
        current_lesson_id: null,
        created_at: '2026-09-27T00:00:00Z',
        updated_at: '2026-09-27T00:00:00Z',
      },
    ] satisfies Schemas['ClassOut'][]),
  )
}

/**
 * The bulk commit refusing the whole submission, in the shape the router actually sends:
 * `detail` is an object carrying the rows to fix, not a string and not FastAPI's array.
 */
export function bulkRefused() {
  return http.post(`/api/classes/${CLASS_ID}/roster/bulk`, () =>
    HttpResponse.json(
      {
        detail: {
          message: 'nothing was added — fix these entries and submit again',
          entries: [{ index: 0, action: 'name_clash', reason: 'a student named Chen W is already in this class' }],
        },
      },
      { status: 422 },
    ),
  )
}

/** A student with no files yet — a brand-new account, which must create one. */
export function noDocuments() {
  return http.get('/api/me/documents', () =>
    HttpResponse.json([] satisfies Schemas['DocumentSummaryOut'][]),
  )
}

/** Counts saves, so a test can prove the autosave debounce coalesces typing. */
export function countSaves() {
  const calls: { id: string; content: string | null | undefined }[] = []
  const handler = http.patch('/api/me/documents/:id', async ({ params, request }) => {
    const body = (await request.json()) as Schemas['DocumentPatch']
    calls.push({ id: params.id as string, content: body.content })
    return HttpResponse.json({ ...documents[DOC_ID]!, content: body.content ?? '' })
  })
  return { calls, handler }
}

/** Creating a file, for the brand-new-student path. */
export function createsDocument(id = 'new-doc-id') {
  return http.post('/api/me/documents', () =>
    HttpResponse.json(
      {
        id,
        title: 'Untitled',
        content: '# Write your Python here, then press Run.\nprint("Hello!")\n',
        status: 'active',
        created_at: '2026-10-02T00:00:00Z',
        updated_at: '2026-10-02T00:00:00Z',
      } satisfies Schemas['DocumentOut'],
      { status: 201 },
    ),
  )
}

/** A signed-out student: every student route refuses. */
export function signedOut() {
  return [
    http.get('/api/auth/student/me', () =>
      HttpResponse.json({ detail: 'not signed in' }, { status: 401 }),
    ),
    http.get('/api/me/documents', () =>
      HttpResponse.json({ detail: 'not signed in' }, { status: 401 }),
    ),
  ]
}

/** A session revoked mid-lesson: reads still cached, but saves refuse. */
export function savesRefused() {
  return http.patch('/api/me/documents/:id', () =>
    HttpResponse.json({ detail: 'session is no longer valid' }, { status: 401 }),
  )
}

/**
 * A rename onto a name already in use, as the API answers it: 409 with a sentence written
 * for a child.
 *
 * Only *renames* are refused — a PATCH carrying a title. Autosave uses the same endpoint
 * with content only, and failing that too would make the test prove the wrong thing.
 */
export function renameRefused() {
  return http.patch('/api/me/documents/:id', async ({ params, request }) => {
    const body = (await request.json()) as Schemas['DocumentPatch']
    if (body.title) {
      // The API deliberately does not echo the attempted name: the index is on
      // lower(title), so "SPIRAL" clashing with "spiral" would make that a false claim.
      return HttpResponse.json(
        { detail: 'you already have a file with that name' },
        { status: 409 },
      )
    }
    const found = documents[params.id as string]!
    if (body.content !== null && body.content !== undefined) found.content = body.content
    return HttpResponse.json(found)
  })
}
