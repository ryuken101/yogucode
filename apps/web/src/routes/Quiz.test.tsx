/**
 * Quizzes on screen: the quiz is the only place a child can be while it runs, the clock
 * counts down and then says the work is in, Check disappears when the quiz turns it off,
 * and the teacher can start and stop it.
 */

import { screen, waitFor } from '@testing-library/react'
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
    leaves: [{ problem_id: ITEM, leaf_item_id: ITEM, title: 'Add to the end', difficulty: 1, attempt_id: null,
      progress: 'not_started', handed_in: false, changed_since_hand_in: false, feedback: null }],
    ...overrides,
  }
}

beforeEach(() => {
  server.use(http.get(`/api/me/homework/${QUIZ}`, () => HttpResponse.json(sheet())))
})

function activeQuiz(endsAt = inTenMinutes()) {
  server.use(
    http.get('/api/me/quiz', () =>
      HttpResponse.json({ assignment_id: QUIZ, title: 'Lists quiz', ends_at: endsAt } satisfies Schemas['ActiveQuizOut']),
    ),
  )
}

function renderStudent(route: string) {
  return renderScreen(
    <Routes>
      <Route element={<RequireStudent />}>
        <Route path="/home" element={<p>Home page</p>} />
        <Route path="/work" element={<p>My files page</p>} />
        <Route path="/quiz/:assignmentId" element={<QuizRunner />} />
        <Route path="/lesson/:assignmentId/:itemId" element={<p>Question page</p>} />
      </Route>
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
  expect(screen.getByRole('link', { name: /Add to the end/ })).toHaveAttribute('href', `/lesson/${QUIZ}/${ITEM}`)
})

test('when time is up the page says the work is in', async () => {
  renderStudent(`/quiz/${QUIZ}`) // no active quiz: it has ended
  expect(await screen.findByText(/Time’s up — your answers have been handed in/)).toBeInTheDocument()
})

/* --- checks off in a quiz ---------------------------------------------------------------- */

test('Check is hidden when the quiz turns it off; Run stays', async () => {
  activeQuiz()
  server.use(
    http.post(`/api/me/assignments/${QUIZ}/items/${ITEM}/open`, () =>
      HttpResponse.json({
        assignment_id: QUIZ, item_id: ITEM, kind: 'code', title: 'Add to the end', prompt_md: '', difficulty: 1,
        mode: 'quiz', completions: false, checks: false, options: [],
        leaves: [{ item_id: ITEM, label: null, prompt_md: '', tests: [], hints: [], next_hint: null,
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
    questions: [{ id: ITEM, title: 'Add to the end', kind: 'code', difficulty: 1 }],
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
  expect(await screen.findByText('Live page')).toBeInTheDocument()
  expect(started).toBe(true)
})
