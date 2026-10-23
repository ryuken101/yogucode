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
import type { ExampleRun, TestRun } from '../runtime/protocol'
import { renderScreen } from '../test/render'
import { server } from '../test/server'
import { ProblemEditor } from './ProblemEditor'

vi.mock('../editor/CodeSurface', () => ({
  CodeSurface: ({ value, onChange }: { value: string; onChange: (next: string) => void }) => (
    <textarea aria-label="code" defaultValue={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

const check = vi.fn<(code: string, tests: unknown[]) => Promise<TestRun | null>>()
const example = vi.fn<(code: string, inputs: string[]) => Promise<ExampleRun | null>>()
vi.mock('../runtime/usePython', () => ({
  usePython: () => ({
    state: { status: 'idle' }, output: [], check, example, run: vi.fn(), stop: vi.fn(), answer: vi.fn(),
  }),
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
    shared_file: false,
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
  example.mockReset()
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

/* --- examples, one file across parts, and previews (17 Oct 2026) -------------------------- */

const greeting: ExampleRun = {
  error: null,
  transcript: [
    { kind: 'out', text: 'Name? ' },
    { kind: 'in', text: 'Ken' },
    { kind: 'out', text: 'Hi Ken\n' },
  ],
}

test('an example is run with the solution, shown, and its run sent at publish', async () => {
  check.mockResolvedValue(passing)
  example.mockResolvedValue(greeting)
  const { user } = renderEditor()
  await user.click(await screen.findByRole('button', { name: 'Add an example' }))
  await user.type(screen.getByLabelText(/What the student types/), 'Ken')
  await user.click(screen.getByRole('button', { name: 'Check solution' }))

  await screen.findByText('The solution passes every check.')
  expect(example).toHaveBeenCalledWith(readyDoc().solution_code, ['Ken'])
  expect(screen.getByLabelText('Example run')).toHaveTextContent('Name? Ken Hi Ken')

  await user.click(screen.getByRole('button', { name: 'Publish' }))
  await waitFor(() => expect(published?.transcripts).toEqual({ '': [greeting.transcript] }))
})

test('splitting into parts keeps one file on the problem, and each part checks it', async () => {
  check.mockResolvedValue(passing)
  const { user } = renderEditor()
  await user.click(await screen.findByRole('button', { name: 'Split into parts (a, b, c)' }))

  expect(screen.getByRole('heading', { name: 'The file' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Check solution' }))
  await screen.findByText('The solution passes every check.')
  expect(stored.document.shared_file).toBe(true)
  expect(stored.document.solution_code).toBe(readyDoc().solution_code)
  expect(stored.document.parts?.[0]?.solution_code).toBe('')
  // Part (a)'s checks ran against the file's solution.
  expect(check).toHaveBeenCalledWith(readyDoc().solution_code, expect.any(Array))
})

test('a part’s prompt can be previewed', async () => {
  const { user } = renderEditor()
  await user.click(await screen.findByRole('button', { name: 'Split into parts (a, b, c)' }))
  await user.type(screen.getByLabelText(/What the student reads for this part/), 'Use **append**')
  const previews = screen.getAllByRole('button', { name: 'Preview' })
  await user.click(previews.at(-1)!)
  expect(screen.getByText('append', { selector: 'strong' })).toBeInTheDocument()
})

test('Preview as student shows the problem as a child meets it', async () => {
  const { user } = renderEditor()
  await user.click(await screen.findByRole('button', { name: 'Split into parts (a, b, c)' }))
  await user.click(screen.getByRole('button', { name: 'Add a part' }))
  await user.click(screen.getByRole('button', { name: 'Preview as student' }))

  const preview = within(screen.getByRole('dialog', { name: 'Preview as student' }))
  expect(preview.getByRole('heading', { name: 'Add to the list' })).toBeInTheDocument()
  expect(preview.getByRole('tab', { name: 'Part (a)' })).toHaveAttribute('aria-selected', 'true')
  await user.click(preview.getByRole('tab', { name: 'Part (b)' }))
  expect(preview.getByRole('tab', { name: 'Part (b)' })).toHaveAttribute('aria-selected', 'true')
  // The starter, in the one file, whichever part is showing.
  expect(preview.getByLabelText('code')).toHaveValue(readyDoc().starter_code)
})

test('a custom check starts from an example and is run against the solution as one', async () => {
  check.mockResolvedValue(passing)
  const { user } = renderEditor()
  await user.selectOptions(await screen.findByLabelText('Checks that it…'), 'script')

  expect(screen.getByText(/runs their program/)).toBeInTheDocument()
  const codes = screen.getAllByLabelText('code')
  expect((codes.at(-1) as HTMLTextAreaElement).value).toContain('for guess in range(10):')

  await user.click(screen.getByRole('button', { name: 'Check solution' }))
  await screen.findByText('The solution passes every check.')
  expect(check.mock.calls[0]![1]).toEqual([
    expect.objectContaining({ kind: 'script', code: expect.stringContaining('run(guess)'), reveal: true }),
  ])
})

test('"matches my solution" is a form, and Check solution runs it with the plain solution', async () => {
  check.mockResolvedValue(passing)
  const { user } = renderEditor()
  await user.selectOptions(await screen.findByLabelText('Checks that it…'), 'compare')

  expect(screen.getByText('Tries 10 cases')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Add a value they choose' }))
  await user.type(screen.getByLabelText('Variable'), 'ships')
  await user.selectOptions(screen.getByLabelText('It must be'), 'numbers')

  await user.click(screen.getByRole('button', { name: 'Check solution' }))
  await screen.findByText('The solution passes every check.')
  expect(check.mock.calls[0]![1]).toEqual([
    expect.objectContaining({
      kind: 'compare',
      inputs: [{ mode: 'range', start: 0, end: 9 }],
      chosen: [{ name: 'ships', rule: { type: 'numbers', count: 3, min: 0, max: 9, distinct: true } }],
      solution: readyDoc().solution_code,
      reveal: true,
    }),
  ])
})

test('a problem with no checks can still be checked and published', async () => {
  stored = problemOut({
    document: { ...readyDoc(), tests: [] },
    publish_warnings: ['The problem has no checks — students can Run it, but there is nothing to Check'],
  })
  check.mockResolvedValue({ compile_error: null, results: [] })
  const { user } = renderEditor()
  await user.click(await screen.findByRole('button', { name: 'Check solution' }))
  await screen.findByText('The solution passes every check.')
  expect(screen.getAllByText(/has no checks/)[0]).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Publish' }))
  // Asked first, since a child can't tell whether they're right (23 Oct 2026)...
  expect(published).toBeNull()
  await user.click(await screen.findByRole('button', { name: 'Publish anyway' }))
  // ...and allowed, since some problems are open-ended.
  await waitFor(() => expect(published).not.toBeNull())
})
