/**
 * Homework on both sides: the child's sheet (check, confirm, hand in; read-only once given
 * back) and the teacher's marking (pre-filled from a re-run, saved as they move along).
 *
 * Python is a stub whose `check` each test scripts; the grader is tested for real in
 * `grader.node.test.ts`.
 */

import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { beforeEach, expect, test, vi } from 'vitest'
import type { Schemas } from '../lib/api'
import type { TestRun } from '../runtime/protocol'
import { renderScreen } from '../test/render'
import { server } from '../test/server'
import { HomeworkSheet } from './HomeworkSheet'
import { Marking } from './Marking'
import { Cell } from './Progress'

const check = vi.fn<(code: string, tests: unknown[]) => Promise<TestRun | null>>()
vi.mock('../runtime/usePython', () => ({
  usePython: () => ({ state: { status: 'idle' }, output: [], check, run: vi.fn(), stop: vi.fn(), answer: vi.fn() }),
}))

const HW = '018f0000-0000-7000-8000-0000000000a1'
const P1 = '018f0000-0000-7000-8000-0000000000b1'
const P2 = '018f0000-0000-7000-8000-0000000000b2'
const A1 = '018f0000-0000-7000-8000-0000000000c1'
const A2 = '018f0000-0000-7000-8000-0000000000c2'

const test1: Schemas['IoTest'] = { kind: 'io', name: 'prints', hidden: false, stdin: '', expected: '5', match: 'exact' }

function leaf(overrides: Partial<Schemas['SheetLeafOut']>): Schemas['SheetLeafOut'] {
  return {
    problem_id: P1, leaf_item_id: P1, title: 'Add to the end', difficulty: 1, attempt_id: null,
    progress: 'not_started', handed_in: false, changed_since_hand_in: false, feedback: null,
    ...overrides,
  }
}

function sheet(overrides: Partial<Schemas['SheetOut']> = {}): Schemas['SheetOut'] {
  return {
    assignment_id: HW, title: 'Lists practice', due_at: '2099-10-16T05:00:00Z', closed: false,
    returned: false, late: false, handed_in_at: null, note: null,
    leaves: [
      leaf({ attempt_id: A1, progress: 'passing' }),
      leaf({ problem_id: P2, leaf_item_id: P2, title: 'Countdown' }),
    ],
    ...overrides,
  }
}

function opened(problemId: string, attemptId: string, code: string): Schemas['StudentProblemOut'] {
  return {
    assignment_id: HW, item_id: problemId, title: '', prompt_md: '', difficulty: 1,
    mode: 'homework', completions: true, kind: 'code', checks: true, options: [],
    leaves: [{
      item_id: problemId, label: null, prompt_md: '', tests: [test1], hints: [], next_hint: null,
      attempt: { id: attemptId, code, status: 'in_progress', run_count: 0, last_passed: null, last_total: null, choice: null },
    }],
  }
}

let handedIn: Schemas['HandInIn'] | null = null

beforeEach(() => {
  handedIn = null
  check.mockReset()
})

function renderSheet() {
  return renderScreen(
    <Routes>
      <Route path="/homework/:assignmentId" element={<HomeworkSheet />} />
    </Routes>,
    { route: `/homework/${HW}` },
  )
}

test('hand in checks every problem first and shows how each one is doing', async () => {
  server.use(
    http.get(`/api/me/homework/${HW}`, () => HttpResponse.json(sheet())),
    http.post(`/api/me/assignments/${HW}/items/${P1}/open`, () => HttpResponse.json(opened(P1, A1, 'print(5)'))),
    http.post(`/api/me/assignments/${HW}/items/${P2}/open`, () => HttpResponse.json(opened(P2, A2, ''))),
    http.post(`/api/me/homework/${HW}/hand-in`, async ({ request }) => {
      handedIn = (await request.json()) as Schemas['HandInIn']
      return HttpResponse.json(sheet({ handed_in_at: '2026-10-07T01:00:00Z' }))
    }),
  )
  check.mockImplementation(async (code) => ({
    compile_error: null,
    results: [{ name: 'prints', hidden: false, passed: code === 'print(5)' }],
  }))
  const { user } = renderSheet()

  await user.click(await screen.findByRole('button', { name: 'Hand in' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('1 of 1 passing')).toBeInTheDocument()
  expect(within(dialog).getByText('not started')).toBeInTheDocument()
  expect(handedIn).toBeNull()

  await user.click(within(dialog).getByRole('button', { name: 'Hand in' }))
  await waitFor(() => expect(handedIn).not.toBeNull())
  expect(handedIn!.results).toEqual([
    { attempt_id: A1, passed: 1, total: 1 },
    { attempt_id: A2, passed: 0, total: 1 },
  ])
  expect(await screen.findByText(/Handed in/)).toBeInTheDocument()
})

test('given-back work is read-only: comments and colours, no numbers, no system-error', async () => {
  server.use(
    http.get(`/api/me/homework/${HW}`, () =>
      HttpResponse.json(
        sheet({
          returned: true,
          note: 'Great loops this week!',
          leaves: [
            leaf({ attempt_id: A1, feedback: { code: 'print(5)', comment_md: 'Lovely', outcome: 'good' } }),
            leaf({ problem_id: P2, leaf_item_id: P2, title: 'Countdown', attempt_id: A2,
                   feedback: { code: '', comment_md: 'Check your range', outcome: 'not_yet' } }),
          ],
        }),
      ),
    ),
  )
  renderSheet()

  expect(await screen.findByText('Great loops this week!')).toBeInTheDocument()
  expect(screen.getByText('Spot on')).toBeInTheDocument()
  const notYet = screen.getByText('Not yet')
  expect(notYet.className).toContain('not-yet')
  expect(screen.queryByRole('button', { name: /Hand in/ })).not.toBeInTheDocument()
  expect(document.body.innerHTML).not.toContain('system-error')
})

/* --- marking --------------------------------------------------------------------------- */

const S1 = '018f0000-0000-7000-8000-0000000000e1'
const S2 = '018f0000-0000-7000-8000-0000000000e2'

function entry(overrides: Partial<Schemas['MarkingEntryOut']>): Schemas['MarkingEntryOut'] {
  return {
    student_id: S1, display_name: 'Aria K', attempt_id: A1, code: 'print(5)', source: 'hand_in',
    submitted_at: '2026-10-07T01:00:00Z', late: false, child_passed: 1, child_total: 1,
    hints_used: 1, mark: null, note: '', ...overrides,
  }
}

test('marking pre-fills Runs and Correct from the re-run and saves when moving on', async () => {
  const marks: { attempt: string; body: Schemas['MarkIn'] }[] = []
  server.use(
    http.get(`/api/assignments/${HW}/marking`, () =>
      HttpResponse.json({
        assignment_id: HW, title: 'Lists practice', due_at: null, released_at: null,
        questions: [{ leaf_item_id: P1, title: 'Add to the end', difficulty: 1, handed_in: 2, marked: 0 }],
        students: [],
      } satisfies Schemas['MarkingOverviewOut']),
    ),
    http.get(`/api/assignments/${HW}/marking/${P1}`, () =>
      HttpResponse.json({
        assignment_id: HW, leaf_item_id: P1, kind: 'code', options: [], title: 'Add to the end', prompt_md: '', solution_code: '',
        concept_ids: [], tests: [test1, { ...test1, name: 'hidden one', hidden: true }],
        entries: [
          entry({}),
          entry({ student_id: S2, display_name: 'Bella N', attempt_id: A2, code: 'print(4)', source: 'not_handed_in', late: true }),
        ],
      } satisfies Schemas['QuestionMarkingOut']),
    ),
    http.get('/api/snippets', () => HttpResponse.json([])),
    http.put('/api/attempts/:id/mark', async ({ params, request }) => {
      const body = (await request.json()) as Schemas['MarkIn']
      marks.push({ attempt: params.id as string, body })
      return HttpResponse.json({ ...body, comment_md: body.comment_md ?? '', approach: body.approach ?? null,
        verified_passed: null, verified_total: null, released: false, stale: false } satisfies Schemas['MarkOut'])
    }),
  )
  // Aria passes both checks, Bella only the first.
  check.mockImplementation(async (code) => ({
    compile_error: null,
    results: [
      { name: 'prints', hidden: false, passed: true },
      { name: 'hidden one', hidden: false, passed: code === 'print(5)' },
    ],
  }))
  // The grader is asked to reveal hidden tests to the teacher.
  const { user } = renderScreen(
    <Routes>
      <Route path="/assignments/:assignmentId/mark/:itemId" element={<Marking />} />
    </Routes>,
    { route: `/assignments/${HW}/mark/${P1}` },
  )

  await screen.findByRole('heading', { name: 'Aria K' })
  await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Correct' })).toBeInTheDocument())
  await waitFor(() =>
    expect(within(screen.getByRole('radiogroup', { name: 'Correct' })).getByRole('radio', { name: '2' })).toHaveAttribute('aria-checked', 'true'),
  )
  expect(check.mock.calls[0]![1]).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'hidden one', hidden: false })]))

  await user.click(within(screen.getByRole('radiogroup', { name: 'Approach' })).getByRole('radio', { name: '1' }))
  await user.type(screen.getByLabelText('Comment for the student'), 'Nice')
  await user.keyboard('{Escape}')
  screen.getByRole('heading', { name: 'Aria K' }).focus()
  await user.click(screen.getByRole('button', { name: 'Next child' }))

  await screen.findByRole('heading', { name: 'Bella N' })
  expect(marks).toEqual([
    { attempt: A1, body: expect.objectContaining({ runs: true, correct: 2, approach: 1, comment_md: 'Nice', verified_passed: 2, verified_total: 2 }) },
  ])
  // Bella: one of two passing → Correct 1, and her lateness shows as not-yet, not system-error.
  await waitFor(() =>
    expect(within(screen.getByRole('radiogroup', { name: 'Correct' })).getByRole('radio', { name: '1' })).toHaveAttribute('aria-checked', 'true'),
  )
  expect(screen.getByText('Late').className).toContain('not-yet')
  expect(screen.getByText('Not handed in — saved work')).toBeInTheDocument()
})

/* --- progress -------------------------------------------------------------------------- */

test('progress cells use the calm tones, and late is not-yet', () => {
  const { container } = renderScreen(
    <>
      <Cell cell={{ status: 'not_started', late: false }} />
      <Cell cell={{ status: 'passing', late: false }} />
      <Cell cell={{ status: 'handed_in', late: true }} />
    </>,
  )
  expect(container.innerHTML).not.toContain('system-error')
  expect(screen.getByText('✓ passing').className).toContain('good')
  expect(screen.getByText('· late').className).toContain('not-yet')
})
