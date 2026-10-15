/**
 * The people on a class page: removing a child from the class, putting them back, the
 * Teachers box, and "My classes" on the Classes page (Ken's decisions, 10 Oct 2026).
 *
 * Removing a child keeps their history and signs them out, so the page says that in
 * words before doing it. Nothing here is the error colour: a name clash on put-back and
 * "every class needs a Lead" are things the teacher can fix.
 */

import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { beforeEach, expect, test } from 'vitest'
import type { Schemas } from '../lib/api'
import { renderScreen } from '../test/render'
import { ARIA_ID, CLASS_ID, server } from '../test/server'
import { ClassDetail } from './ClassDetail'
import { ClassList } from './ClassList'

const KLASS: Schemas['ClassDetailOut'] = {
  id: CLASS_ID,
  name: 'Year 4-6 Python',
  term_label: null,
  status: 'active',
  course_id: null,
  current_lesson_id: null,
  join_code: 'WNPXYZ',
  is_mine: true,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
}

const entry = (
  id: string,
  name: string,
  status: Schemas['RosterEntryOut']['status'] = 'active',
): Schemas['RosterEntryOut'] => ({
  student_id: id,
  display_name: name,
  username: name.toLowerCase().replace(' ', '.'),
  has_pin: true,
  pin_viewable: true,
  student_status: 'active',
  status,
  joined_at: '2026-10-01T00:00:00Z',
  withdrawn_at: status === 'withdrawn' ? '2026-10-10T00:00:00Z' : null,
})

const CHEN = '018f0000-0000-7000-8000-0000000000c1'
const KEN = { user_id: 'u1', display_name: 'Ken', email: 'ken@example.com', role: 'lead' as const, is_you: true }
const SAM = { user_id: 'u2', display_name: 'Sam Lee', email: 'sam@school.test' }

let teachers: Schemas['ClassTeacherOut'][]
let role: 'owner' | 'teacher'

beforeEach(() => {
  teachers = [KEN]
  role = 'owner'
  server.use(
    http.get('/api/auth/me', () =>
      HttpResponse.json({
        id: 'u1', email: 'ken@example.com', display_name: 'Ken', role,
        centre: { id: 'c1', name: 'Magikid Castle Hill', slug: 'castle-hill' },
      } satisfies Schemas['TeacherProfileOut']),
    ),
    http.get(`/api/classes/${CLASS_ID}`, () => HttpResponse.json(KLASS)),
    http.get(`/api/classes/${CLASS_ID}/homework`, () => HttpResponse.json([])),
    http.get(`/api/classes/${CLASS_ID}/quizzes`, () => HttpResponse.json([])),
    http.get('/api/courses', () => HttpResponse.json([])),
    http.get(`/api/classes/${CLASS_ID}/teachers`, () => HttpResponse.json(teachers)),
    http.get(`/api/classes/${CLASS_ID}/teachers/candidates`, () =>
      HttpResponse.json(teachers.some((t) => t.user_id === SAM.user_id) ? [] : [SAM]),
    ),
  )
})

function classPage() {
  return renderScreen(
    <Routes>
      <Route path="/classes/:classId" element={<ClassDetail />} />
    </Routes>,
    { route: `/classes/${CLASS_ID}` },
  )
}

// --- removing a child ---------------------------------------------------------------------

test('removing a child asks first, in words, then takes them off the roster', async () => {
  let withdrawn = ''
  let roster = [entry(ARIA_ID, 'Aria K')]
  server.use(
    http.get(`/api/classes/${CLASS_ID}/roster`, () => HttpResponse.json(roster)),
    http.post(`/api/classes/${CLASS_ID}/enrolments/:id/withdraw`, ({ params }) => {
      withdrawn = String(params.id)
      roster = []
      return HttpResponse.json(entry(ARIA_ID, 'Aria K', 'withdrawn'))
    }),
  )
  const { user } = classPage()

  await user.click(await screen.findByRole('button', { name: 'Remove from class' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('Remove Aria K from this class?')).toBeInTheDocument()
  expect(within(dialog).getByText(/signed out straight away/)).toBeInTheDocument()
  expect(within(dialog).getByText(/saved work, homework and marks are kept/)).toBeInTheDocument()
  expect(withdrawn).toBe('')

  await user.click(within(dialog).getByRole('button', { name: 'Remove from class' }))
  await waitFor(() => expect(withdrawn).toBe(ARIA_ID))
  await waitFor(() => expect(screen.queryByText('Aria K')).not.toBeInTheDocument())
  expect(document.body.innerHTML).not.toMatch(/system-error|strawberry/)
})

test('removed children are listed on request and can be put back', async () => {
  let putBack = ''
  server.use(
    http.get(`/api/classes/${CLASS_ID}/roster`, ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.get('include_withdrawn')
          ? [entry(ARIA_ID, 'Aria K'), entry(CHEN, 'Chen W', 'withdrawn')]
          : [entry(ARIA_ID, 'Aria K')],
      ),
    ),
    http.post(`/api/classes/${CLASS_ID}/enrolments/:id/reinstate`, ({ params }) => {
      putBack = String(params.id)
      return HttpResponse.json(entry(CHEN, 'Chen W'))
    }),
  )
  const { user } = classPage()

  expect(await screen.findByText('Aria K')).toBeInTheDocument()
  expect(screen.queryByText('Chen W')).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: /Show removed students/ }))
  const chen = (await screen.findByText('Chen W')).closest('li')!
  expect(within(chen).getByText(/removed \d/)).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Put back' }))
  await waitFor(() => expect(putBack).toBe(CHEN))
})

test('a name clash on put-back is not-yet, not an error', async () => {
  server.use(
    http.get(`/api/classes/${CLASS_ID}/roster`, ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.get('include_withdrawn')
          ? [entry(CHEN, 'Chen W', 'withdrawn')]
          : [],
      ),
    ),
    http.post(`/api/classes/${CLASS_ID}/enrolments/:id/reinstate`, () =>
      HttpResponse.json(
        { detail: 'Someone in this class is already called Chen W.' },
        { status: 409 },
      ),
    ),
  )
  const { user } = classPage()

  await user.click(await screen.findByRole('button', { name: /Show removed students/ }))
  await user.click(await screen.findByRole('button', { name: 'Put back' }))
  const message = await screen.findByText('Someone in this class is already called Chen W.')
  expect(message.className).toContain('not-yet')
})

// --- the Teachers box --------------------------------------------------------------------------

test('a teacher can be added as an assistant', async () => {
  let added: unknown = null
  server.use(
    http.put(`/api/classes/${CLASS_ID}/teachers/:userId`, async ({ params, request }) => {
      added = { userId: params.userId, ...((await request.json()) as object) }
      teachers = [KEN, { ...SAM, role: 'assistant', is_you: false }]
      return HttpResponse.json(teachers)
    }),
  )
  const { user } = classPage()

  expect(await screen.findByText('Ken')).toBeInTheDocument()
  await user.selectOptions(await screen.findByLabelText('Add a teacher'), SAM.user_id)
  await user.click(screen.getByRole('button', { name: 'Add' }))

  await waitFor(() => expect(added).toEqual({ userId: SAM.user_id, role: 'assistant' }))
  const sam = (await screen.findByText('Sam Lee')).closest('li')!
  expect(within(sam).getByText('Assistant', { selector: 'span' })).toBeInTheDocument()
})

test('"every class needs a Lead" is something to fix, not an error', async () => {
  server.use(
    http.post(`/api/classes/${CLASS_ID}/teachers/:userId/remove`, () =>
      HttpResponse.json(
        { detail: 'Every class needs a Lead. Make someone else Lead first.' },
        { status: 409 },
      ),
    ),
  )
  const { user } = classPage()

  await screen.findByText('Ken')
  const teachersCard = screen.getByText('Who teaches this class. Any teacher at the centre can still open it.')
    .parentElement!
  await user.click(within(teachersCard).getByRole('button', { name: 'Remove' }))
  const message = await screen.findByText('Every class needs a Lead. Make someone else Lead first.')
  expect(message.className).toContain('not-yet')
})

// --- My classes ---------------------------------------------------------------------------------

test('the class list puts my classes first', async () => {
  const base = { term_label: null, status: 'active' as const, course_id: null, current_lesson_id: null,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' }
  server.use(
    http.get('/api/classes', () =>
      HttpResponse.json([
        { ...base, id: 'c-other', name: 'Sam’s Thursday class', is_mine: false },
        { ...base, id: 'c-mine', name: 'Year 4-6 Python', is_mine: true },
      ] satisfies Schemas['ClassOut'][]),
    ),
  )
  renderScreen(<ClassList />)

  const mine = await screen.findByRole('heading', { name: 'My classes' })
  const others = screen.getByRole('heading', { name: 'Other classes' })
  expect(within(mine.parentElement!).getByText('Year 4-6 Python')).toBeInTheDocument()
  expect(within(others.parentElement!).getByText('Sam’s Thursday class')).toBeInTheDocument()
})

test('with only my classes there are no group headings', async () => {
  server.use(
    http.get('/api/classes', () =>
      HttpResponse.json([{ ...KLASS, join_code: undefined } as unknown as Schemas['ClassOut']]),
    ),
  )
  renderScreen(<ClassList />)
  expect(await screen.findByText('Year 4-6 Python')).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'My classes' })).not.toBeInTheDocument()
})

// --- removing a whole class -----------------------------------------------------------------

test('removing a class asks first, in words, then goes back to the class list', async () => {
  let archived = false
  server.use(
    http.get(`/api/classes/${CLASS_ID}/roster`, () => HttpResponse.json([])),
    http.post(`/api/classes/${CLASS_ID}/archive`, () => {
      archived = true
      return HttpResponse.json({ ...KLASS, status: 'archived' })
    }),
  )
  const { user } = renderScreen(
    <Routes>
      <Route path="/classes/:classId" element={<ClassDetail />} />
      <Route path="/classes" element={<p>Class list</p>} />
    </Routes>,
    { route: `/classes/${CLASS_ID}` },
  )

  await user.click(await screen.findByRole('button', { name: 'Remove class' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('Remove Year 4-6 Python?')).toBeInTheDocument()
  expect(within(dialog).getByText(/join code stops working/)).toBeInTheDocument()
  expect(within(dialog).getByText(/work, homework and marks are kept/)).toBeInTheDocument()
  expect(archived).toBe(false)

  await user.click(within(dialog).getByRole('button', { name: 'Archive class' }))
  expect(await screen.findByText('Class list')).toBeInTheDocument()
  expect(archived).toBe(true)
})

test('a removed class says so and can be put back from its page', async () => {
  let restored = false
  server.use(
    http.get(`/api/classes/${CLASS_ID}`, () => HttpResponse.json({ ...KLASS, status: 'archived' })),
    http.get(`/api/classes/${CLASS_ID}/roster`, () => HttpResponse.json([])),
    http.post(`/api/classes/${CLASS_ID}/unarchive`, () => {
      restored = true
      return HttpResponse.json(KLASS)
    }),
  )
  const { user } = classPage()

  expect(await screen.findByText(/This class has been removed/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Remove class' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Put back' }))
  await waitFor(() => expect(restored).toBe(true))
})

test('removed classes are listed on request and can be put back', async () => {
  let restored = ''
  const base = { term_label: null, course_id: null, current_lesson_id: null, is_mine: true,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' }
  server.use(
    http.get('/api/classes', ({ request }) =>
      HttpResponse.json(
        (new URL(request.url).searchParams.get('include_archived')
          ? [
              { ...base, id: 'c-live', name: 'Year 4-6 Python', status: 'active' },
              { ...base, id: 'c-old', name: 'Term 3 Python', status: 'archived' },
            ]
          : [{ ...base, id: 'c-live', name: 'Year 4-6 Python', status: 'active' }]) satisfies Schemas['ClassOut'][],
      ),
    ),
    http.post('/api/classes/:id/unarchive', ({ params }) => {
      restored = String(params.id)
      return HttpResponse.json({ ...base, id: 'c-old', name: 'Term 3 Python', status: 'active' })
    }),
  )
  const { user } = renderScreen(<ClassList />)

  expect(await screen.findByText('Year 4-6 Python')).toBeInTheDocument()
  expect(screen.queryByText('Term 3 Python')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /Show removed classes/ }))
  expect(await screen.findByText('Term 3 Python')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Put back' }))
  await waitFor(() => expect(restored).toBe('c-old'))
})

// --- delete entirely (owner only) --------------------------------------------------------------

test('the owner can delete a child entirely, after typing their name', async () => {
  let deleted: unknown = null
  server.use(
    http.get(`/api/classes/${CLASS_ID}/roster`, () => HttpResponse.json([entry(ARIA_ID, 'Aria K')])),
    http.post('/api/students/:id/delete', async ({ params, request }) => {
      deleted = { id: params.id, ...((await request.json()) as object) }
      return new HttpResponse(null, { status: 204 })
    }),
  )
  const { user } = classPage()

  await user.click(await screen.findByRole('button', { name: 'Remove from class' }))
  await user.click(await screen.findByRole('button', { name: 'Delete entirely…' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('Delete Aria K entirely?')).toBeInTheDocument()
  expect(within(dialog).getByText('This can’t be undone.')).toBeInTheDocument()

  const confirm = within(dialog).getByRole('button', { name: 'Delete entirely' })
  expect(confirm).toBeDisabled()
  await user.type(within(dialog).getByLabelText('Type Aria K to confirm'), 'aria k')
  expect(confirm).toBeEnabled()
  await user.click(confirm)
  await waitFor(() => expect(deleted).toEqual({ id: ARIA_ID, confirm_name: 'aria k' }))
  // No red: the warning is in the words.
  expect(document.body.innerHTML).not.toMatch(/system-error|strawberry/)
})

test('a teacher who is not the owner only sees Archive', async () => {
  role = 'teacher'
  server.use(
    http.get(`/api/classes/${CLASS_ID}/roster`, () => HttpResponse.json([entry(ARIA_ID, 'Aria K')])),
  )
  const { user } = classPage()
  await user.click(await screen.findByRole('button', { name: 'Remove from class' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByRole('button', { name: 'Remove from class' })).toBeInTheDocument()
  expect(within(dialog).queryByRole('button', { name: 'Delete entirely…' })).not.toBeInTheDocument()
})

test('the owner can delete a class entirely, after typing its name', async () => {
  let deleted: unknown = null
  server.use(
    http.get(`/api/classes/${CLASS_ID}/roster`, () => HttpResponse.json([])),
    http.post(`/api/classes/${CLASS_ID}/delete`, async ({ request }) => {
      deleted = await request.json()
      return new HttpResponse(null, { status: 204 })
    }),
  )
  const { user } = renderScreen(
    <Routes>
      <Route path="/classes/:classId" element={<ClassDetail />} />
      <Route path="/classes" element={<p>Class list</p>} />
    </Routes>,
    { route: `/classes/${CLASS_ID}` },
  )
  await user.click(await screen.findByRole('button', { name: 'Remove class' }))
  await user.click(await screen.findByRole('button', { name: 'Delete entirely…' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText(/accounts and their own files stay/)).toBeInTheDocument()
  await user.type(within(dialog).getByLabelText('Type Year 4-6 Python to confirm'), 'Year 4-6 Python')
  await user.click(within(dialog).getByRole('button', { name: 'Delete entirely' }))
  expect(await screen.findByText('Class list')).toBeInTheDocument()
  expect(deleted).toEqual({ confirm_name: 'Year 4-6 Python' })
})

// --- permanent accounts: add, PIN, username (Ken's decisions, 11 Oct 2026) ------------------

function classPageWithSlips() {
  return renderScreen(
    <Routes>
      <Route path="/classes/:classId" element={<ClassDetail />} />
      <Route path="/classes/:classId/slips" element={<p>Slips page</p>} />
    </Routes>,
    { route: `/classes/${CLASS_ID}` },
  )
}

test('Add a student suggests a username and goes to the slip', async () => {
  let created: unknown = null
  server.use(
    http.get(`/api/classes/${CLASS_ID}/roster`, () => HttpResponse.json([])),
    http.get('/api/students/username-suggestion', ({ request }) =>
      HttpResponse.json({
        username: new URL(request.url).searchParams.get('name') === 'Aria Kim' ? 'aria.k' : 'x',
      }),
    ),
    http.post(`/api/classes/${CLASS_ID}/students`, async ({ request }) => {
      created = await request.json()
      return HttpResponse.json(
        { student_id: ARIA_ID, display_name: 'Aria Kim', username: 'aria.k', pin: '4827' },
        { status: 201 },
      )
    }),
  )
  const { user } = classPageWithSlips()

  await user.click(await screen.findByRole('button', { name: 'Add a student' }))
  const dialog = screen.getByRole('dialog')
  await user.type(within(dialog).getByLabelText('Name'), 'Aria Kim')
  await waitFor(() => expect(within(dialog).getByLabelText('Username')).toHaveValue('aria.k'))
  await user.type(within(dialog).getByLabelText('PIN (4 digits)'), '4827')
  await user.click(within(dialog).getByRole('button', { name: 'Add student' }))

  expect(await screen.findByText('Slips page')).toBeInTheDocument()
  expect(created).toEqual({ display_name: 'Aria Kim', username: 'aria.k', pin: '4827' })
})

test('a taken username is something to fix, with a one-click alternative', async () => {
  server.use(
    http.get(`/api/classes/${CLASS_ID}/roster`, () => HttpResponse.json([])),
    http.get('/api/students/username-suggestion', () => HttpResponse.json({ username: 'aria.k' })),
    http.post(`/api/classes/${CLASS_ID}/students`, () =>
      HttpResponse.json(
        {
          detail: {
            code: 'username_taken',
            message: 'That username is taken — how about aria.k2?',
            suggestion: 'aria.k2',
          },
        },
        { status: 409 },
      ),
    ),
  )
  const { user } = classPage()
  await user.click(await screen.findByRole('button', { name: 'Add a student' }))
  const dialog = screen.getByRole('dialog')
  await user.type(within(dialog).getByLabelText('Name'), 'Aria Kim')
  await user.click(within(dialog).getByRole('button', { name: 'Add student' }))

  const message = await within(dialog).findByText(/how about aria.k2/)
  expect(message.className).toContain('not-yet')
  await user.click(within(dialog).getByRole('button', { name: 'Use aria.k2' }))
  expect(within(dialog).getByLabelText('Username')).toHaveValue('aria.k2')
})

test('the roster shows usernames, and who still needs a PIN', async () => {
  server.use(
    http.get(`/api/classes/${CLASS_ID}/roster`, () =>
      HttpResponse.json([{ ...entry(ARIA_ID, 'Aria K'), has_pin: false, pin_viewable: false }]),
    ),
  )
  classPage()
  expect(await screen.findByText('aria.k')).toBeInTheDocument()
  expect(screen.getByText('No PIN yet').className).toContain('not-yet')
  expect(screen.getByRole('button', { name: 'Set PIN' })).toBeInTheDocument()
})

test('Change PIN sends the chosen PIN and shows the slip', async () => {
  let body: unknown = null
  server.use(
    http.get(`/api/classes/${CLASS_ID}/roster`, () => HttpResponse.json([entry(ARIA_ID, 'Aria K')])),
    http.post(`/api/students/${ARIA_ID}/pin`, async ({ request }) => {
      body = await request.json()
      return HttpResponse.json(
        { student_id: ARIA_ID, display_name: 'Aria K', username: 'aria.k', pin: '5931' },
        { status: 201 },
      )
    }),
  )
  const { user } = classPageWithSlips()
  await user.click(await screen.findByRole('button', { name: 'Change PIN' }))
  const dialog = screen.getByRole('dialog')
  await user.type(within(dialog).getByLabelText('New PIN (4 digits)'), '5931')
  await user.click(within(dialog).getByRole('button', { name: 'Set PIN' }))

  expect(await screen.findByText('Slips page')).toBeInTheDocument()
  expect(body).toEqual({ pin: '5931' })
})

test('leaving the PIN blank asks for a random one', async () => {
  let body: unknown = null
  server.use(
    http.get(`/api/classes/${CLASS_ID}/roster`, () => HttpResponse.json([entry(ARIA_ID, 'Aria K')])),
    http.post(`/api/students/${ARIA_ID}/pin`, async ({ request }) => {
      body = await request.json()
      return HttpResponse.json(
        { student_id: ARIA_ID, display_name: 'Aria K', username: 'aria.k', pin: '5931' },
        { status: 201 },
      )
    }),
  )
  const { user } = classPageWithSlips()
  await user.click(await screen.findByRole('button', { name: 'Change PIN' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Set PIN' }))
  await waitFor(() => expect(body).toEqual({ pin: null }))
})

test('the username can be changed', async () => {
  let body: unknown = null
  server.use(
    http.get(`/api/classes/${CLASS_ID}/roster`, () => HttpResponse.json([entry(ARIA_ID, 'Aria K')])),
    http.patch(`/api/students/${ARIA_ID}`, async ({ request }) => {
      body = await request.json()
      return HttpResponse.json({})
    }),
  )
  const { user } = classPage()
  await user.click(await screen.findByRole('button', { name: 'Username' }))
  const box = within(screen.getByRole('dialog')).getByLabelText('Username')
  expect(box).toHaveValue('aria.k')
  await user.clear(box)
  await user.type(box, 'Aria.Kim')
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(body).toEqual({ username: 'aria.kim' }))
})
