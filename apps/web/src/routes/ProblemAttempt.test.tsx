/**
 * A child working a problem: Check, the "N of M passing" frame, the hint gate, autosave.
 *
 * Monaco is a textarea (uncontrolled, `defaultValue` — see `Work.test.tsx`) and Python is
 * a stub whose `check` each test scripts. The grader itself is covered for real in
 * `grader.node.test.ts`; here it is what the page does with the result.
 */

import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { beforeEach, expect, test, vi } from 'vitest'
import type { Schemas } from '../lib/api'
import type { TestRun } from '../runtime/protocol'
import { renderScreen } from '../test/render'
import { server } from '../test/server'
import { ProblemAttempt } from './ProblemAttempt'

vi.mock('../editor/CodeSurface', () => ({
  CodeSurface: ({ value, onChange }: { value: string; onChange: (next: string) => void }) => (
    <textarea aria-label="Your program" defaultValue={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

const check = vi.fn<(code: string, tests: unknown[]) => Promise<TestRun | null>>()
const run = vi.fn()
vi.mock('../runtime/usePython', () => ({
  usePython: () => ({ state: { status: 'idle' }, output: [], check, run, stop: vi.fn(), answer: vi.fn() }),
}))

const ASSIGNMENT = '018f0000-0000-7000-8000-0000000000d1'
const ITEM = '018f0000-0000-7000-8000-0000000000d2'
const ATTEMPT = '018f0000-0000-7000-8000-0000000000d3'

function leaf(overrides: Partial<Schemas['StudentLeafOut']> = {}): Schemas['StudentLeafOut'] {
  return {
    item_id: ITEM,
    label: null,
    prompt_md: '',
    tests: [
      { kind: 'io', name: 'prints it', hidden: false, stdin: '', expected: '[1, 2, 3, 5]', match: 'exact' },
      { kind: 'io', name: 'secret', hidden: true, stdin: '', expected: '5', match: 'contains' },
    ],
    hints: [],
    next_hint: { level: 1, available: false, runs_needed: 1, seconds_needed: 120 },
    attempt: { id: ATTEMPT, code: 'numbers = [1, 2, 3]\n', status: 'in_progress', run_count: 0, last_passed: null, last_total: null, choice: null },
    ...overrides,
  }
}

const problem = (): Schemas['StudentProblemOut'] => ({
  assignment_id: ASSIGNMENT,
  item_id: ITEM,
  title: 'Add to the end',
  prompt_md: 'Add `5` to the end.',
  difficulty: 1,
  mode: 'classwork',
  completions: true, kind: 'code', checks: true, options: [],
  leaves: [leaf()],
})

const runs: Schemas['RunIn'][] = []
const saves: string[] = []

beforeEach(() => {
  runs.length = 0
  saves.length = 0
  check.mockReset()
  run.mockReset()
  server.use(
    http.post(`/api/me/assignments/${ASSIGNMENT}/items/${ITEM}/open`, () => HttpResponse.json(problem())),
    http.post(`/api/me/attempts/${ATTEMPT}/runs`, async ({ request }) => {
      runs.push((await request.json()) as Schemas['RunIn'])
      return HttpResponse.json(leaf().attempt)
    }),
    http.patch(`/api/me/attempts/${ATTEMPT}`, async ({ request }) => {
      saves.push(((await request.json()) as Schemas['AttemptSaveIn']).code)
      return HttpResponse.json(leaf().attempt)
    }),
    http.post(`/api/me/attempts/${ATTEMPT}/hints`, () =>
      HttpResponse.json(
        leaf({ hints: [{ level: 1, body_md: 'Lists have a method for this.' }], next_hint: null }),
      ),
    ),
  )
})

function renderAttempt() {
  return renderScreen(
    <Routes>
      <Route path="/lesson/:assignmentId/:itemId" element={<ProblemAttempt />} />
    </Routes>,
    { route: `/lesson/${ASSIGNMENT}/${ITEM}` },
  )
}

test('check shows how many pass, in good and not-yet, and reports the result', async () => {
  check.mockResolvedValue({
    compile_error: null,
    results: [
      { name: 'prints it', hidden: false, passed: false, got: '[1, 2, 3]', expected: '[1, 2, 3, 5]', error: null },
      { name: 'secret', hidden: true, passed: true },
    ],
  })
  const { user } = renderAttempt()
  await user.click(await screen.findByRole('button', { name: 'Check' }))

  expect(await screen.findByText('1 of 2 passing')).toBeInTheDocument()
  // The grader is given the hidden test as hidden, so its result carries nothing to leak.
  expect(check.mock.calls[0]![1]).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'secret', hidden: true })]),
  )
  const failing = screen.getByText(/○/).closest('div')!
  expect(failing.className).toContain('not-yet')
  expect(failing.className).not.toContain('system-error')
  await waitFor(() => expect(runs).toEqual([{ passed: 1, total: 2 }]))
})

test('a syntax error is "not yet", with what Python said', async () => {
  check.mockResolvedValue({
    compile_error: "SyntaxError on line 1: '(' was never closed",
    results: [{ name: 'prints it', hidden: false, passed: false }],
  })
  const { user } = renderAttempt()
  await user.click(await screen.findByRole('button', { name: 'Check' }))

  const notice = await screen.findByText(/was never closed/)
  expect(notice.className).toContain('not-yet')
})

test('the hint waits for a run, then opens', async () => {
  const { user } = renderAttempt()
  const hint = await screen.findByRole('button', { name: 'Get a hint' })
  expect(hint).toBeDisabled()
  expect(screen.getByText(/after 1 more run/)).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Run' }))
  expect(run).toHaveBeenCalledWith('numbers = [1, 2, 3]\n')
  await waitFor(() => expect(hint).toBeEnabled())
  await user.click(hint)

  expect(await screen.findByText('Lists have a method for this.')).toBeInTheDocument()
})

test('a refused hint says why, in not-yet', async () => {
  server.use(
    http.post(`/api/me/attempts/${ATTEMPT}/hints`, () =>
      HttpResponse.json({ detail: 'Not yet — try running your code.' }, { status: 409 }),
    ),
  )
  const { user } = renderAttempt()
  await user.click(await screen.findByRole('button', { name: 'Run' }))
  await user.click(screen.getByRole('button', { name: 'Get a hint' }))

  const message = await screen.findByText('Not yet — try running your code.')
  expect(message.className).toContain('not-yet')
})

test('typing saves the attempt', async () => {
  const { user } = renderAttempt()
  const editor = await screen.findByLabelText('Your program')
  await user.type(editor, 'numbers.append(5)')

  await waitFor(() => expect(saves.at(-1)).toContain('numbers.append(5)'), { timeout: 4000 })
})
