/**
 * The problem editor's one hard rule: **Publish is reachable only after the reference
 * solution has passed every check, against the version that is saved.**
 *
 * Monaco is a textarea here (see `Work.test.tsx` for why it must use `defaultValue`), and
 * the Python runtime is a stub whose `check` each test scripts — what is under test is the
 * gating, not Pyodide, which `grader.node.test.ts` covers for real.
 */

import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { beforeEach, expect, test, vi } from 'vitest'
import type { Schemas } from '../lib/api'
import type { TestRun } from '../runtime/protocol'
import { renderScreen } from '../test/render'
import { server } from '../test/server'
import { ProblemEditor } from './ProblemEditor'

vi.mock('../editor/CodeSurface', () => ({
  CodeSurface: ({ value, onChange }: { value: string; onChange: (next: string) => void }) => (
    <textarea aria-label="code" defaultValue={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

const check = vi.fn<(code: string, tests: unknown[]) => Promise<TestRun | null>>()
vi.mock('../runtime/usePython', () => ({
  usePython: () => ({ state: { status: 'idle' }, output: [], check, run: vi.fn(), stop: vi.fn(), answer: vi.fn() }),
}))

const ITEM_ID = '018f0000-0000-7000-8000-0000000000a1'
const LISTS = '018f0000-0000-7000-8000-0000000000c1'

const concepts: Schemas['ConceptOut'][] = [
  { id: LISTS, key: 'lists', label: 'Lists', status: 'provisional' },
]

function readyDoc(): Schemas['ProblemDoc'] {
  return {
    kind: 'code',
    options: [],
    title: 'Add to the list',
    prompt_md: 'Add 5.',
    difficulty: 1,
    concept_ids: [LISTS],
    primary_concept_id: LISTS,
    starter_code: 'numbers = [1, 2, 3]\n',
    solution_code: 'numbers = [1, 2, 3]\nnumbers.append(5)\nprint(numbers)\n',
    tests: [
      { kind: 'io', name: 'prints the list', hidden: false, stdin: '', expected: '[1, 2, 3, 5]', match: 'exact' },
    ],
    hints: [],
    parts: [],
  }
}

/** A one-problem stand-in for the bank, mutable so a save or publish is visible on read. */
let stored: Schemas['ProblemOut']
let saves = 0
let published: Schemas['PublishIn'] | null = null

function problemOut(overrides: Partial<Schemas['ProblemOut']> = {}): Schemas['ProblemOut'] {
  return {
    id: ITEM_ID,
    status: 'draft',
    version: 1,
    supersedes_id: null,
    source_key: null,
    updated_at: '2026-10-03T10:00:00.000001Z',
    document: readyDoc(),
    parts: [],
    publish_problems: [],
    publish_warnings: [],
    ...overrides,
  }
}

beforeEach(() => {
  stored = problemOut()
  saves = 0
  published = null
  check.mockReset()
  server.use(
    http.get('/api/concepts', () => HttpResponse.json(concepts)),
    http.get(`/api/items/${ITEM_ID}`, () => HttpResponse.json(stored)),
    http.post('/api/items', async ({ request }) => {
      const body = (await request.json()) as Schemas['ProblemDoc']
      stored = problemOut({ document: body, publish_problems: ['The problem needs at least one test'] })
      return HttpResponse.json(stored, { status: 201 })
    }),
    http.put(`/api/items/${ITEM_ID}`, async ({ request }) => {
      saves += 1
      const body = (await request.json()) as Schemas['ProblemDoc']
      stored = { ...stored, document: body, updated_at: `2026-10-03T10:0${saves}:00Z` }
      return HttpResponse.json(stored)
    }),
    http.post(`/api/items/${ITEM_ID}/publish`, async ({ request }) => {
      published = (await request.json()) as Schemas['PublishIn']
      stored = { ...stored, status: 'published' }
      return HttpResponse.json(stored)
    }),
  )
})

function renderEditor(route = `/problems/${ITEM_ID}`) {
  return renderScreen(
    <Routes>
      <Route path="/problems/new" element={<ProblemEditor key="p" />} />
      <Route path="/problems/:itemId" element={<ProblemEditor key="p" />} />
    </Routes>,
    { route },
  )
}

const passing: TestRun = {
  compile_error: null,
  results: [{ name: 'prints the list', hidden: false, passed: true, got: '[1, 2, 3, 5]', expected: '[1, 2, 3, 5]', error: null }],
}

test('a new problem is saved as a draft', async () => {
  const { user } = renderEditor('/problems/new')
  await user.type(await screen.findByLabelText('Title'), 'Doubling')
  await user.click(screen.getByRole('button', { name: 'Save draft' }))

  await waitFor(() => expect(stored.document.title).toBe('Doubling'))
  expect(await screen.findByText('Draft')).toBeInTheDocument()
})

test('publish waits for the solution to pass, then sends the version it ran against', async () => {
  check.mockResolvedValue(passing)
  const { user } = renderEditor()
  const publish = await screen.findByRole('button', { name: 'Publish' })
  expect(publish).toBeDisabled()

  await user.click(screen.getByRole('button', { name: 'Check solution' }))
  await screen.findByText('The solution passes every check.')
  expect(check).toHaveBeenCalledWith(readyDoc().solution_code, expect.any(Array))
  expect(publish).toBeEnabled()

  await user.click(publish)
  await waitFor(() => expect(published).not.toBeNull())
  expect(published!.verified_updated_at).toBe('2026-10-03T10:00:00.000001Z')
})

test('a failing solution keeps publish shut and is shown as not-yet, not as an error', async () => {
  check.mockResolvedValue({
    compile_error: null,
    results: [{ name: 'prints the list', hidden: false, passed: false, got: '[1, 2, 3]', expected: '[1, 2, 3, 5]', error: null }],
  })
  const { user } = renderEditor()
  await user.click(await screen.findByRole('button', { name: 'Check solution' }))

  await screen.findByText('The solution does not pass every check yet.')
  expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled()
  const line = screen.getByText(/○/).closest('div')!
  expect(line.className).toContain('not-yet')
  expect(line.className).not.toContain('system-error')
  expect(within(line).getByText('[1, 2, 3]')).toBeInTheDocument()
})

test('an edit after a check makes the check stale', async () => {
  check.mockResolvedValue(passing)
  const { user } = renderEditor()
  await user.click(await screen.findByRole('button', { name: 'Check solution' }))
  await screen.findByText('The solution passes every check.')

  await user.type(screen.getByLabelText('Title'), '!')
  expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled()
  expect(screen.getByText('Check the solution against its tests before publishing.')).toBeInTheDocument()
})

test('checking an unsaved edit saves it first, so the run matches what is stored', async () => {
  check.mockResolvedValue(passing)
  const { user } = renderEditor()
  await user.type(await screen.findByLabelText('Title'), '!')
  await user.click(screen.getByRole('button', { name: 'Check solution' }))

  await screen.findByText('The solution passes every check.')
  expect(saves).toBe(1)
  await user.click(screen.getByRole('button', { name: 'Publish' }))
  await waitFor(() => expect(published?.verified_updated_at).toBe('2026-10-03T10:01:00Z'))
})

test('a published problem is read-only and offers a new version', async () => {
  stored = problemOut({ status: 'published' })
  renderEditor()

  expect(await screen.findByRole('button', { name: 'Make changes' })).toBeInTheDocument()
  expect(screen.getByLabelText('Title')).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument()
})
