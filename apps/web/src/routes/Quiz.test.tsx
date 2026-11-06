/**
 * Quizzes on screen: the quiz is the only place a child can be while it runs, the clock
 * counts down and then says the work is in, Check disappears when the quiz turns it off,
 * and the teacher can start and stop it.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { beforeEach, expect, test, vi } from 'vitest'
import type { Schemas } from '../lib/api'
import { renderScreen } from '../test/render'
import { server } from '../test/server'
import { Live } from './Live'
import { ProblemAttempt } from './ProblemAttempt'
import { QuizBuilder } from './QuizBuilder'
import { QuizRunner } from './QuizRunner'
import { RequireStudent } from './RequireStudent'

vi.mock('../runtime/usePython', () => ({
  usePython: () => ({ state: { status: 'idle' }, output: [], check: vi.fn(), run: vi.fn(), stop: vi.fn(), answer: vi.fn() }),
}))
vi.mock('../editor/CodeSurface', () => ({
  CodeSurface: ({ value }: { value: string }) => <textarea aria-label="Your program" defaultValue={value} />,
}))
vi.mock('../lib/supabase', () => ({ supabaseConfigured: true, currentAccessToken: async () => 'teacher-token' }))

const QUIZ = '018f0000-0000-7000-8000-0000000000q1'
const CLASS = '018f0000-0000-7000-8000-000000000001'
const ITEM = '018f0000-0000-7000-8000-0000000000b1'
const inTenMinutes = () => new Date(Date.now() + 10 * 60_000).toISOString()

function sheet(overrides: Partial<Schemas['SheetOut']> = {}): Schemas['SheetOut'] {
  return {
    assignment_id: QUIZ, title: 'Lists quiz', due_at: null, closed: false, returned: false, late: false,
    handed_in_at: null, note: null,
    leaves: [{ problem_id: ITEM, leaf_item_id: ITEM, title: 'Add to the end', problem_title: 'Add to the end', difficulty: 1, attempt_id: null,
      progress: 'not_started', answered: false, handed_in: false, changed_since_hand_in: false, feedback: null }],
    ...overrides,
  }
}

beforeEach(() => {
  server.use(http.get(`/api/me/homework/${QUIZ}`, () => HttpResponse.json(sheet())))
})

function activeQuiz(endsAt = inTenMinutes()) {
  server.use(
    http.get('/api/me/quiz', () =>
      HttpResponse.json({ assignment_id: QUIZ, title: 'Lists quiz', ends_at: endsAt, finished: false } satisfies Schemas['ActiveQuizOut']),
    ),
  )
}

function renderStudent(route: string) {
  // The guard's desktop shows its pages in windows; these stand in for the real ones.
  const pages = (
    <>
      <Route path="/home" element={<p>Home page</p>} />
      <Route path="/work" element={<p>My files page</p>} />
      <Route path="/quiz/:assignmentId" element={<QuizRunner />} />
      <Route path="/lesson/:assignmentId/:itemId" element={<p>Question page</p>} />
    </>
  )
  return renderScreen(
    <Routes>
      <Route element={<RequireStudent pages={pages} />}>{pages}</Route>
    </Routes>,
    { route },
  )
}

test('while a quiz runs, every other page sends the child to it', async () => {
  activeQuiz()
  renderStudent('/work')
  expect(await screen.findByRole('heading', { name: 'Lists quiz' })).toBeInTheDocument()
  expect(screen.queryByText('My files page')).not.toBeInTheDocument()
})

test('a question of the running quiz is allowed', async () => {
  activeQuiz()
  renderStudent(`/lesson/${QUIZ}/${ITEM}`)
  expect(await screen.findByText('Question page')).toBeInTheDocument()
})

test('the quiz page counts down and lists the questions', async () => {
  activeQuiz()
  renderStudent(`/quiz/${QUIZ}`)
  expect(await screen.findByLabelText('time left')).toHaveTextContent(/^(10:00|9:5\d)$/)
  expect(await screen.findByRole('link', { name: /Add to the end/ })).toHaveAttribute('href', `/quiz/${QUIZ}/${ITEM}`)
})

test('when time is up the page says the work is in', async () => {
  renderStudent(`/quiz/${QUIZ}`) // no active quiz: it has ended
  expect(await screen.findByText(/The quiz has ended, and your answers have been handed in/)).toBeInTheDocument()
})

/** The modal with this title: a native dialog, so found through its heading. */
async function dialogTitled(title: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: title, hidden: true })
  return heading.closest('dialog') as HTMLElement
}

/* --- checks off in a quiz ---------------------------------------------------------------- */

test('Check is hidden when the quiz turns it off; Run stays', async () => {
  activeQuiz()
  server.use(
    http.post(`/api/me/assignments/${QUIZ}/items/${ITEM}/open`, () =>
      HttpResponse.json({
        assignment_id: QUIZ, item_id: ITEM, kind: 'code', title: 'Add to the end', prompt_md: '', difficulty: 1,
        mode: 'quiz', completions: false, checks: false, options: [],
        examples: [], shared_file: false, file_attempt_id: null,
        leaves: [{ item_id: ITEM, label: null, prompt_md: '', tests: [], examples: [], hints: [], next_hint: null,
          attempt: { id: 'a1', code: '', status: 'in_progress', run_count: 0, last_passed: null, last_total: null, choice: null } }],
      } satisfies Schemas['StudentProblemOut']),
    ),
  )
  renderScreen(
    <Routes>
      <Route path="/lesson/:assignmentId/:itemId" element={<ProblemAttempt />} />
    </Routes>,
    { route: `/lesson/${QUIZ}/${ITEM}` },
  )
  expect(await screen.findByRole('button', { name: 'Run' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Check' })).not.toBeInTheDocument()
  expect(screen.getByText(/Checks are off for this quiz/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '← Back to the quiz' })).toHaveAttribute('href', `/quiz/${QUIZ}`)
})

/* --- the teacher -------------------------------------------------------------------------- */

function quizOut(overrides: Partial<Schemas['QuizOut']> = {}): Schemas['QuizOut'] {
  return {
    id: QUIZ, class_id: CLASS, title: 'Lists quiz', status: 'draft', running: false, duration_minutes: 20,
    checks: false, started_at: null, ends_at: null, released_at: null,
    questions: [{ id: ITEM, title: 'Add to the end', kind: 'code', difficulty: 1, newer_version_id: null, superseded: false }],
    ...overrides,
  }
}

test('the live view shows the quiz clock, and Stop stops it', async () => {
  let stopped = false
  server.use(
    http.get(`/api/classes/${CLASS}/quizzes`, () =>
      HttpResponse.json([quizOut({ status: 'open', running: !stopped, ends_at: inTenMinutes() })]),
    ),
    http.post(`/api/quizzes/${QUIZ}/stop`, () => {
      stopped = true
      return HttpResponse.json(quizOut({ status: 'closed' }))
    }),
    http.get(`/api/classes/${CLASS}`, () => HttpResponse.json({ id: CLASS, name: 'Year 4-6', term_label: null,
      status: 'active', course_id: null, current_lesson_id: null, join_code: 'X',
      created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' })),
    http.get(`/api/classes/${CLASS}/roster`, () => HttpResponse.json([])),
  )
  const { user } = renderScreen(
    <Routes>
      <Route path="/classes/:classId/live" element={<Live />} />
    </Routes>,
    { route: `/classes/${CLASS}/live` },
  )

  expect(await screen.findByText('Quiz · Lists quiz')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Stop the quiz' }))
  expect(stopped).toBe(false)
  const dialog = await dialogTitled('Stop the quiz for everyone?')
  await user.click(within(dialog).getByRole('button', { name: 'Stop the quiz', hidden: true }))
  await waitFor(() => expect(stopped).toBe(true))
  await waitFor(() => expect(screen.queryByText('Quiz · Lists quiz')).not.toBeInTheDocument())
})

test('starting from the builder starts the quiz and opens the live view', async () => {
  let started = false
  server.use(
    http.get(`/api/quizzes/${QUIZ}`, () => HttpResponse.json(quizOut())),
    http.get(`/api/classes/${CLASS}`, () => HttpResponse.json({ id: CLASS, name: 'Year 4-6', term_label: null,
      status: 'active', course_id: null, current_lesson_id: null, join_code: 'X',
      created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' })),
    http.get('/api/items', () => HttpResponse.json([])),
    http.post(`/api/quizzes/${QUIZ}/start`, () => {
      started = true
      return HttpResponse.json(quizOut({ status: 'open', running: true, ends_at: inTenMinutes() }))
    }),
  )
  const { user } = renderScreen(
    <Routes>
      <Route path="/classes/:classId/quizzes/:quizId" element={<QuizBuilder />} />
      <Route path="/classes/:classId/live" element={<p>Live page</p>} />
    </Routes>,
    { route: `/classes/${CLASS}/quizzes/${QUIZ}` },
  )

  const checksBox = await screen.findByLabelText(/Let students press Check/)
  expect(checksBox).not.toBeChecked()
  await user.click(screen.getByRole('button', { name: 'Start the quiz now' }))
  expect(started).toBe(false)
  const dialog = await dialogTitled('Start the quiz for everyone?')
  await user.click(within(dialog).getByRole('button', { name: 'Start the quiz', hidden: true }))
  expect(await screen.findByText('Live page')).toBeInTheDocument()
  expect(started).toBe(true)
})

/* --- the length field, and Start refused ---------------------------------------------------- */

function newQuizScreen() {
  server.use(
    http.get(`/api/classes/${CLASS}`, () => HttpResponse.json({ id: CLASS, name: 'Year 4-6', term_label: null,
      status: 'active', course_id: null, current_lesson_id: null, join_code: 'X',
      created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' })),
    http.get('/api/items', () => HttpResponse.json([
      { id: ITEM, title: 'Add to the end', difficulty: 1, kind: 'code', status: 'published', version: 1,
        concept_ids: [], primary_concept_id: null, part_labels: [], test_count: 1, folder_ids: [],
        updated_at: '2026-10-01T00:00:00Z' },
    ])),
  )
  return renderScreen(
    <Routes>
      <Route path="/classes/:classId/quizzes/new" element={<QuizBuilder />} />
      <Route path="/classes/:classId/quizzes/:quizId" element={<QuizBuilder />} />
    </Routes>,
    { route: `/classes/${CLASS}/quizzes/new` },
  )
}

test('clearing the length and typing a new one gives that number, not 130', async () => {
  const { user } = newQuizScreen()
  const length = await screen.findByLabelText('Length (minutes)')
  await user.clear(length)
  expect(length).toHaveValue('')
  await user.type(length, '30')
  expect(length).toHaveValue('30')
})

test('the length takes whole minutes and stays between 1 and 180', async () => {
  const { user } = newQuizScreen()
  const length = await screen.findByLabelText('Length (minutes)')
  await user.clear(length)
  await user.type(length, '1.5')
  expect(length).toHaveValue('15')
  await user.clear(length)
  await user.type(length, '999')
  await user.tab()
  expect(length).toHaveValue('180')
  await user.clear(length)
  await user.type(length, '0')
  await user.tab()
  expect(length).toHaveValue('1')
})

test('Start refused because another quiz runs: pressing it again makes no second quiz', async () => {
  let created = 0
  let updated = 0
  server.use(
    http.post(`/api/classes/${CLASS}/quizzes`, () => {
      created += 1
      return HttpResponse.json(quizOut(), { status: 201 })
    }),
    http.get(`/api/quizzes/${QUIZ}`, () => HttpResponse.json(quizOut())),
    http.patch(`/api/quizzes/${QUIZ}`, () => {
      updated += 1
      return HttpResponse.json(quizOut())
    }),
    http.post(`/api/quizzes/${QUIZ}/start`, () =>
      HttpResponse.json({ detail: 'Another quiz is running in this class' }, { status: 409 }),
    ),
  )
  const { user } = newQuizScreen()
  await user.type(await screen.findByLabelText('Title'), 'Second quiz')
  await user.click(screen.getByRole('button', { name: 'Add problems' }))
  await user.click(await screen.findByRole('checkbox', { name: /Add to the end/, hidden: true }))
  await user.click(screen.getByRole('button', { name: 'Add 1 problem', hidden: true }))
  for (let press = 0; press < 2; press++) {
    await user.click(screen.getByRole('button', { name: 'Start the quiz now' }))
    const dialog = await dialogTitled('Start the quiz for everyone?')
    await user.click(within(dialog).getByRole('button', { name: 'Start the quiz', hidden: true }))
    expect(await screen.findByText('Another quiz is running in this class')).toBeInTheDocument()
  }
  expect(created).toBe(1)
  expect(updated).toBe(0)
})

test('a running quiz offers Watch and Stop, and no marking until it has finished', async () => {
  server.use(
    http.get(`/api/quizzes/${QUIZ}`, () =>
      HttpResponse.json(quizOut({ status: 'open', running: true, ends_at: inTenMinutes() })),
    ),
    http.get(`/api/classes/${CLASS}`, () => HttpResponse.json({ id: CLASS, name: 'Year 4-6', term_label: null,
      status: 'active', course_id: null, current_lesson_id: null, join_code: 'X',
      created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' })),
    http.get('/api/items', () => HttpResponse.json([])),
  )
  renderScreen(
    <Routes>
      <Route path="/classes/:classId/quizzes/:quizId" element={<QuizBuilder />} />
    </Routes>,
    { route: `/classes/${CLASS}/quizzes/${QUIZ}` },
  )
  expect(await screen.findByRole('button', { name: 'Watch' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Stop the quiz' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Mark' })).not.toBeInTheDocument()
})

/* --- I'm finished ---------------------------------------------------------------------------- */

test("I'm finished names what's unanswered, and they can go back and edit", async () => {
  activeQuiz()
  let finished = false
  server.use(
    http.post(`/api/me/quiz/${QUIZ}/finish`, () => {
      finished = true
      return HttpResponse.json({ assignment_id: QUIZ, title: 'Lists quiz', ends_at: inTenMinutes(), finished: true })
    }),
    http.post(`/api/me/quiz/${QUIZ}/resume`, () => {
      finished = false
      return HttpResponse.json({ assignment_id: QUIZ, title: 'Lists quiz', ends_at: inTenMinutes(), finished: false })
    }),
  )
  const user = userEvent.setup()
  renderStudent(`/quiz/${QUIZ}`)
  await user.click(await screen.findByRole('button', { name: 'I’m finished' }))
  const dialog = await dialogTitled('Are you finished?')
  expect(within(dialog).getByText('Add to the end')).toBeInTheDocument()
  await user.click(within(dialog).getByRole('button', { name: 'I’m finished', hidden: true }))
  await waitFor(() => expect(finished).toBe(true))
  expect(await screen.findByText(/You’ve finished/)).toBeInTheDocument()
  // Still in the quiz: the questions are there to reopen.
  expect(screen.getByRole('link', { name: /Add to the end/ })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Go back and edit' }))
  await waitFor(() => expect(finished).toBe(false))
})

test('an answered question says so, and a real part label is the only one taken off', async () => {
  activeQuiz()
  server.use(
    http.get(`/api/me/homework/${QUIZ}`, () =>
      HttpResponse.json(sheet({
        leaves: [
          { problem_id: ITEM, leaf_item_id: ITEM, title: 'Tricky one (a)', problem_title: 'Tricky one (a)', difficulty: 1,
            attempt_id: null, progress: 'started', answered: true, handed_in: false, changed_since_hand_in: false, feedback: null },
        ],
      })),
    ),
  )
  renderStudent(`/quiz/${QUIZ}`)
  const row = await screen.findByRole('link', { name: /Tricky one \(a\)/ })
  expect(within(row).getByText('Answered')).toBeInTheDocument()
})
