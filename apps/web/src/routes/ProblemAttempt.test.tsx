/**
 * A child working a problem: Check, the "N of M passing" frame, the hint gate, autosave.
 *
 * Monaco is a textarea (uncontrolled, `defaultValue` — see `Work.test.tsx`) and Python is
 * a stub whose `check` each test scripts. The grader itself is covered for real in
 * `grader.node.test.ts`; here it is what the page does with the result.
 */

import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { useState } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { Schemas } from '../lib/api'
import type { TestRun } from '../runtime/protocol'
import { renderScreen } from '../test/render'
import { server } from '../test/server'
import { DeskContext } from '../desktop/context'
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
    examples: [],
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
  examples: [], shared_file: false, file_attempt_id: null,
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

test('Run and Check straight after typing use what is on screen', async () => {
  check.mockResolvedValue({ compile_error: null, results: [] })
  const { user } = renderAttempt()
  const box = await screen.findByLabelText('Your program')
  await user.clear(box)
  await user.type(box, 'print(2 * 4)')
  await user.click(screen.getByRole('button', { name: 'Run' }))
  expect(run).toHaveBeenLastCalledWith('print(2 * 4)')
  await user.click(screen.getByRole('button', { name: 'Check' }))
  await waitFor(() => expect(check).toHaveBeenCalled())
  expect(check.mock.calls.at(-1)![0]).toBe('print(2 * 4)')
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

test('on a shared file, the parts are one program: switching keeps the code, checks stay per part', async () => {
  const PART_B = '018f0000-0000-7000-8000-0000000000d4'
  const ATTEMPT_B = '018f0000-0000-7000-8000-0000000000d5'
  const partB = leaf({
    item_id: PART_B,
    label: 'b',
    prompt_md: 'Now triple it.',
    attempt: { ...leaf().attempt, id: ATTEMPT_B },
  })
  const bRuns: Schemas['RunIn'][] = []
  server.use(
    http.post(`/api/me/assignments/${ASSIGNMENT}/items/${ITEM}/open`, () =>
      HttpResponse.json({
        ...problem(),
        shared_file: true,
        file_attempt_id: ATTEMPT,
        leaves: [leaf({ label: 'a', prompt_md: 'Double it.' }), partB],
      }),
    ),
    http.post(`/api/me/attempts/${ATTEMPT_B}/runs`, async ({ request }) => {
      bRuns.push((await request.json()) as Schemas['RunIn'])
      return HttpResponse.json(partB.attempt)
    }),
  )
  check.mockResolvedValue({ compile_error: null, results: [{ name: 'prints it', hidden: false, passed: true }] })
  const { user } = renderAttempt()
  await user.type(await screen.findByLabelText('Your program'), 'x = 1')
  await user.click(screen.getByRole('tab', { name: 'Part (b)' }))

  expect(screen.getByText('Now triple it.')).toBeInTheDocument()
  expect(screen.getByLabelText('Your program')).toHaveValue('numbers = [1, 2, 3]\nx = 1')
  await user.click(screen.getByRole('button', { name: 'Check' }))
  await waitFor(() => expect(bRuns).toEqual([{ passed: 1, total: 1 }]))
  expect(check.mock.calls[0]![0]).toBe('numbers = [1, 2, 3]\nx = 1')
  // Everything typed went to the one file's attempt.
  await waitFor(() => expect(saves.at(-1)).toBe('numbers = [1, 2, 3]\nx = 1'))
})

test('a "matches my solution" check takes the server’s scrambled solution to the grader', async () => {
  const compare: Schemas['CompareTest'] = {
    kind: 'compare', name: 'plays like mine', hidden: false, match: 'exact',
    inputs: [{ mode: 'range', start: 0, end: 9 }], chosen: [], reference: 'c2NyYW1ibGVk',
  }
  server.use(
    http.post(`/api/me/assignments/${ASSIGNMENT}/items/${ITEM}/open`, () =>
      HttpResponse.json({ ...problem(), leaves: [leaf({ tests: [compare] })] }),
    ),
  )
  check.mockResolvedValue({ compile_error: null, results: [{ name: 'plays like mine', hidden: false, passed: true }] })
  const { user } = renderAttempt()
  await user.click(await screen.findByRole('button', { name: 'Check' }))
  await waitFor(() => expect(check).toHaveBeenCalled())
  expect(check.mock.calls[0]![1]).toEqual([
    expect.objectContaining({ kind: 'compare', reference: 'c2NyYW1ibGVk', reveal: false }),
  ])
  expect(check.mock.calls[0]![1][0]).not.toHaveProperty('solution')
})

test('a part with no checks offers Run, not a Check with nothing to try', async () => {
  server.use(
    http.post(`/api/me/assignments/${ASSIGNMENT}/items/${ITEM}/open`, () =>
      HttpResponse.json({ ...problem(), leaves: [leaf({ tests: [] })] }),
    ),
  )
  renderAttempt()
  expect(await screen.findByText(/no checks for this one/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Check' })).not.toBeInTheDocument()
})

/* --- bugs from the class of 17 Oct 2026 --------------------------------------------------- */

/** The problem in a window that can be closed and opened again, as the desktop does. */
function Reopenable() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen((now) => !now)}>
        {open ? 'Close the window' : 'Open the window'}
      </button>
      {open ? (
        <Routes>
          <Route path="/lesson/:assignmentId/:itemId" element={<ProblemAttempt />} />
        </Routes>
      ) : null}
    </>
  )
}

test('closing and reopening the problem shows what was saved, not the copy it opened with', async () => {
  let onServer = 'numbers = [1, 2, 3]\n'
  server.use(
    http.post(`/api/me/assignments/${ASSIGNMENT}/items/${ITEM}/open`, () =>
      HttpResponse.json({ ...problem(), leaves: [leaf({ attempt: { ...leaf().attempt, code: onServer } })] }),
    ),
    http.patch(`/api/me/attempts/${ATTEMPT}`, async ({ request }) => {
      onServer = ((await request.json()) as Schemas['AttemptSaveIn']).code
      return HttpResponse.json({ ...leaf().attempt, code: onServer })
    }),
  )
  const { user, client } = renderScreen(<Reopenable />, { route: `/lesson/${ASSIGNMENT}/${ITEM}` })
  // The app keeps queries after they unmount; the test client normally does not.
  client.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } })

  await user.click(screen.getByRole('button', { name: 'Open the window' }))
  await user.type(await screen.findByLabelText('Your program'), 'numbers.append(5)')
  await user.click(screen.getByRole('button', { name: 'Close the window' })) // saves what is waiting
  await user.click(screen.getByRole('button', { name: 'Open the window' }))
  await waitFor(() =>
    expect(screen.getByLabelText('Your program')).toHaveValue('numbers = [1, 2, 3]\nnumbers.append(5)'),
  )
})

test('the first Save asks where to keep it, then keeps the work in that file', async () => {
  let linked: Schemas['FileLinkIn'] | null = null
  let made: Schemas['DocumentIn'] | null = null
  server.use(
    http.get('/api/me/folders', () => HttpResponse.json([])),
    http.get('/api/me/documents', () => HttpResponse.json([])),
    http.post('/api/me/documents', async ({ request }) => {
      made = (await request.json()) as Schemas['DocumentIn']
      return HttpResponse.json(
        { id: 'file-1', title: made.title, folder_id: null, status: 'active', content: made.content ?? '', created_at: '2026-10-17T00:00:00Z', updated_at: '2026-10-17T00:00:00Z' },
        { status: 201 },
      )
    }),
    http.put(`/api/me/attempts/${ATTEMPT}/file`, async ({ request }) => {
      linked = (await request.json()) as Schemas['FileLinkIn']
      return HttpResponse.json({ ...leaf().attempt, document_id: 'file-1' })
    }),
  )
  const { user } = renderAttempt()
  await screen.findByLabelText('Your program')
  await user.click(screen.getByRole('button', { name: 'Save' }))

  const dialog = within(screen.getByRole('dialog', { name: 'Save to my files' }))
  expect(dialog.getByLabelText('File name')).toHaveValue('Add to the end.py')
  await user.click(dialog.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(linked).toEqual({ document_id: 'file-1' }))
  expect(made).toMatchObject({ title: 'Add to the end.py', folder_id: null, content: 'numbers = [1, 2, 3]\n' })
})

test('New folder makes a folder without closing the Save window, and Put it away opens Files', async () => {
  const FOLDER = '018f0000-0000-7000-8000-0000000000f1'
  let folders: Schemas['FolderOut'][] = []
  let made: Schemas['DocumentIn'] | null = null
  const openBeside = vi.fn()
  server.use(
    http.get('/api/me/folders', () => HttpResponse.json(folders)),
    http.post('/api/me/folders', async ({ request }) => {
      const body = (await request.json()) as Schemas['FolderIn']
      const folder = { id: FOLDER, name: body.name, parent_id: body.parent_id ?? null, status: 'active', created_at: '2026-10-18T00:00:00Z', updated_at: '2026-10-18T00:00:00Z' } as Schemas['FolderOut']
      folders = [folder]
      return HttpResponse.json(folder, { status: 201 })
    }),
    http.get('/api/me/documents', () => HttpResponse.json([])),
    http.post('/api/me/documents', async ({ request }) => {
      made = (await request.json()) as Schemas['DocumentIn']
      return HttpResponse.json(
        { id: 'file-1', title: made.title, folder_id: made.folder_id, status: 'active', content: made.content ?? '', created_at: '2026-10-18T00:00:00Z', updated_at: '2026-10-18T00:00:00Z' },
        { status: 201 },
      )
    }),
    http.put(`/api/me/attempts/${ATTEMPT}/file`, () => HttpResponse.json({ ...leaf().attempt, document_id: 'file-1' })),
  )
  const { user } = renderScreen(
    <DeskContext.Provider value={{ role: 'student', classId: null, isOwner: false, openBeside }}>
      <Routes>
        <Route path="/lesson/:assignmentId/:itemId" element={<ProblemAttempt />} />
      </Routes>
    </DeskContext.Provider>,
    { route: `/lesson/${ASSIGNMENT}/${ITEM}` },
  )
  await screen.findByLabelText('Your program')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Save to my files' }))

  // Every button here used to submit the form, saving to My work and closing the window.
  await user.click(dialog.getByRole('button', { name: /New folder/ }))
  await user.type(dialog.getByLabelText('New folder name'), 'Games')
  await user.click(dialog.getByRole('button', { name: 'Make it' }))
  expect(await dialog.findByRole('option', { name: 'My work / Games', selected: true })).toBeInTheDocument()
  expect(made).toBeNull()

  await user.click(dialog.getByRole('button', { name: 'Put it away in Files…' }))
  await waitFor(() => expect(openBeside).toHaveBeenCalledWith('files', `/my-files?select=file-1&folder=${FOLDER}`))
  expect(made).toMatchObject({ folder_id: FOLDER })
})
