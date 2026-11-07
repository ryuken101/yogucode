/**
 * Multiple choice on screen: answering never gives the answer away, publishing needs no
 * run, and marking reads the class's answers as misconceptions.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { beforeEach, expect, test, vi } from 'vitest'
import { McqAttempt } from '../components/McqAttempt'
import type { Schemas } from '../lib/api'
import { renderScreen } from '../test/render'
import { server } from '../test/server'
import { Marking } from './Marking'
import { ProblemEditor } from './ProblemEditor'

vi.mock('../runtime/usePython', () => ({
  usePython: () => ({ state: { status: 'idle' }, output: [], check: vi.fn(), run: vi.fn(), stop: vi.fn(), answer: vi.fn() }),
}))

test('a chosen answer is grape, never good or not-yet, and saves', async () => {
  const chosen: number[] = []
  render(<McqAttempt options={['[0, 1, 2, 3, 4]', '[1, 2, 3, 4, 5]']} initial={null} onChoose={async (c) => void chosen.push(c)} />)
  await userEvent.click(screen.getByRole('radio', { name: '[1, 2, 3, 4, 5]' }))

  const picked = screen.getByRole('radio', { name: '[1, 2, 3, 4, 5]' })
  expect(picked).toHaveAttribute('aria-checked', 'true')
  expect(picked.className).toContain('grape')
  expect(document.body.innerHTML).not.toMatch(/-good|not-yet|system-error/)
  expect(chosen).toEqual([1])
})

/* --- authoring -------------------------------------------------------------------------- */

const ITEM = '018f0000-0000-7000-8000-0000000000a1'
const RANGE = '018f0000-0000-7000-8000-0000000000c1'

function mcqOut(overrides: Partial<Schemas['ProblemOut']> = {}): Schemas['ProblemOut'] {
  return {
    id: ITEM, status: 'draft', version: 1, supersedes_id: null, source_key: null,
    updated_at: '2026-10-08T10:00:00Z', parts: [], publish_problems: [],
    publish_warnings: ['1 wrong option without a misconception — naming it is what makes the answers diagnostic'],
    document: {
      kind: 'mcq', shared_file: false, title: 'range(5)', prompt_md: '', difficulty: 1, concept_ids: [RANGE],
      primary_concept_id: RANGE, starter_code: '', solution_code: '', tests: [], hints: [], parts: [],
      options: [{ text: '[0..4]', correct: true, misconception: null }, { text: '[1..5]', correct: false, misconception: null }],
    },
    ...overrides,
  }
}

test('a multiple-choice question publishes with no solution check, and warns about bare options', async () => {
  let published: Schemas['PublishIn'] | null = null
  server.use(
    http.get('/api/concepts', () => HttpResponse.json([{ id: RANGE, key: 'range', label: 'Range', status: 'provisional' }])),
    http.get(`/api/items/${ITEM}`, () => HttpResponse.json(mcqOut())),
    http.post(`/api/items/${ITEM}/publish`, async ({ request }) => {
      published = (await request.json()) as Schemas['PublishIn']
      return HttpResponse.json(mcqOut({ status: 'published' }))
    }),
  )
  const { user } = renderScreen(
    <Routes>
      <Route path="/problems/:itemId" element={<ProblemEditor />} />
    </Routes>,
    { route: `/problems/${ITEM}` },
  )

  expect(await screen.findByLabelText('Option 2')).toHaveValue('[1..5]')
  expect(screen.queryByRole('button', { name: 'Check solution' })).not.toBeInTheDocument()
  expect(screen.getByText(/without a misconception/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Publish' }))
  await waitFor(() => expect(published).toEqual({ verified_updated_at: '2026-10-08T10:00:00Z', transcripts: {} }))
})

/* --- marking ----------------------------------------------------------------------------- */

const HW = '018f0000-0000-7000-8000-0000000000b1'

beforeEach(() => {
  server.use(
    http.get('/api/snippets', () => HttpResponse.json([])),
    http.get(`/api/assignments/${HW}/marking`, () =>
      HttpResponse.json({
        assignment_id: HW, title: 'Quiz', mode: 'homework', due_at: null, released_at: null, students: [],
        questions: [{ leaf_item_id: ITEM, title: 'range(5)', difficulty: 1, handed_in: 2, marked: 0 }],
      } satisfies Schemas['MarkingOverviewOut']),
    ),
  )
})

test('marking shows how many chose each option, with the misconception, and pre-fills Correct', async () => {
  let autoMarked = false
  server.use(
    http.get(`/api/assignments/${HW}/marking/${ITEM}`, () =>
      HttpResponse.json({
        assignment_id: HW, leaf_item_id: ITEM, kind: 'mcq', title: 'range(5)', prompt_md: '', solution_code: '',
        concept_ids: [], tests: [],
        options: [
          { text: '[0..4]', correct: true, misconception: null, chosen_by: 1 },
          { text: '[0..5]', correct: false, misconception: 'thinks range includes the end', chosen_by: 6 },
        ],
        entries: [{
          student_id: 's1', display_name: 'Aria K', attempt_id: 'a1', code: '', source: 'hand_in', submitted_at: null,
          late: false, child_passed: null, child_total: null, hints_used: 0, mark: null, note: '', choice: 1,
        }],
      } satisfies Schemas['QuestionMarkingOut']),
    ),
    http.post(`/api/assignments/${HW}/marking/${ITEM}/auto`, () => {
      autoMarked = true
      return HttpResponse.json({ marked: 7 })
    }),
  )
  const { user } = renderScreen(
    <Routes>
      <Route path="/assignments/:assignmentId/mark/:itemId" element={<Marking />} />
    </Routes>,
    { route: `/assignments/${HW}/mark/${ITEM}` },
  )

  // Every option is listed, the child's picked out, and a wrong one is never red.
  const answers = await screen.findByRole('list', { name: 'The class’s answers' })
  const [right, theirs] = within(answers).getAllByRole('listitem')
  expect(within(right!).getByText('right').className).toContain('good')
  expect(within(right!).getByText('1 chose this')).toBeInTheDocument()
  expect(within(right!).queryByText('Their answer')).not.toBeInTheDocument()
  expect(within(theirs!).getByText('Their answer')).toBeInTheDocument()
  expect(within(theirs!).getByText('not yet').className).toContain('not-yet')
  expect(within(theirs!).getByText('6 chose this')).toBeInTheDocument()
  expect(within(theirs!).getByText('Suggests: thinks range includes the end')).toBeInTheDocument()
  expect(answers.innerHTML).not.toContain('strawberry')
  expect(answers.innerHTML).not.toContain('system-error')
  // Multiple choice has no solution to show and nothing to run.
  expect(screen.queryByRole('button', { name: 'Show solution' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument()
  // Wrong answer → Correct 0, and no Approach for multiple choice.
  expect(within(screen.getByRole('radiogroup', { name: 'Correct' })).getByRole('radio', { name: '0' })).toHaveAttribute('aria-checked', 'true')
  expect(screen.queryByRole('radiogroup', { name: 'Approach' })).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Mark all automatically' }))
  await waitFor(() => expect(autoMarked).toBe(true))
})

test('marking says when a child chose nothing', async () => {
  server.use(
    http.get(`/api/assignments/${HW}/marking/${ITEM}`, () =>
      HttpResponse.json({
        assignment_id: HW, leaf_item_id: ITEM, kind: 'mcq', title: 'range(5)', prompt_md: 'What prints?', solution_code: '',
        concept_ids: [], tests: [],
        options: [{ text: '[0..4]', correct: true, misconception: null, chosen_by: 0 }],
        entries: [{
          student_id: 's1', display_name: 'Aria K', attempt_id: 'a1', code: '', source: 'not_handed_in', submitted_at: null,
          late: false, child_passed: null, child_total: null, hints_used: 0, mark: null, note: '', choice: null,
        }],
      } satisfies Schemas['QuestionMarkingOut']),
    ),
  )
  renderScreen(
    <Routes>
      <Route path="/assignments/:assignmentId/mark/:itemId" element={<Marking />} />
    </Routes>,
    { route: `/assignments/${HW}/mark/${ITEM}` },
  )
  expect(await screen.findByText('No answer chosen.')).toBeInTheDocument()
  expect(screen.getByText('What prints?')).toBeInTheDocument()
  expect(screen.queryByText('Their answer')).not.toBeInTheDocument()
})
