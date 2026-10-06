/**
 * Import and bulk publish: the two ways a batch of problems reaches the bank.
 *
 * Import is offered only after an error-free preview *of the text as it now stands*; bulk
 * publish publishes only what passes, and says why for what it leaves as a draft.
 */

import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, expect, test, vi } from 'vitest'
import type { Schemas } from '../lib/api'
import { PublishDrafts } from '../problems/PublishDrafts'
import type { TestRun } from '../runtime/protocol'
import { renderScreen } from '../test/render'
import { server } from '../test/server'
import { ProblemImport } from './ProblemImport'

const check = vi.fn<(code: string) => Promise<TestRun | null>>()
vi.mock('../runtime/usePython', () => ({
  usePython: () => ({ state: { status: 'idle' }, output: [], check, run: vi.fn(), stop: vi.fn(), answer: vi.fn() }),
}))

let applied = 0
const imports: Schemas['ImportIn'][] = []

function entry(overrides: Partial<Schemas['ImportEntryOut']> = {}): Schemas['ImportEntryOut'] {
  return { key: 'add-five', title: 'Add to the end', action: 'create', item_id: null, error: null, publish_problems: [], ...overrides }
}

beforeEach(() => {
  applied = 0
  imports.length = 0
  check.mockReset()
  server.use(
    http.post('/api/items/import', async ({ request }) => {
      const body = (await request.json()) as Schemas['ImportIn']
      imports.push(body)
      const bad = body.yaml.includes('time_travel')
      if (body.apply && !bad) applied += 1
      return HttpResponse.json({
        applied: body.apply && !bad,
        error: null,
        entries: bad ? [entry(), entry({ key: 'x', title: 'Bad', action: 'error', error: 'unknown concept time_travel' })] : [entry()],
      } satisfies Schemas['ImportReportOut'])
    }),
  )
})

test('import is offered only after a clean preview of the current text', async () => {
  const { user } = renderScreen(<ProblemImport />)
  const importButton = screen.getByRole('button', { name: /^Import/ })
  await user.type(screen.getByLabelText('…or paste it here'), 'problems: none')
  expect(importButton).toBeDisabled()

  await user.click(screen.getByRole('button', { name: 'Preview' }))
  await screen.findByText('Add to the end')
  expect(imports.at(-1)?.apply).toBe(false)
  expect(screen.getByRole('button', { name: 'Import 1 problem' })).toBeEnabled()

  // Editing after the preview means the preview no longer describes what would be sent.
  await user.type(screen.getByLabelText('…or paste it here'), ' ')
  expect(screen.getByRole('button', { name: /^Import/ })).toBeDisabled()
})

test('a file with a bad entry cannot be imported', async () => {
  const { user } = renderScreen(<ProblemImport />)
  await user.type(screen.getByLabelText('…or paste it here'), 'time_travel')
  await user.click(screen.getByRole('button', { name: 'Preview' }))

  expect(await screen.findByText('unknown concept time_travel')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /^Import/ })).toBeDisabled()
})

test('applying imports and points at the bank', async () => {
  const { user } = renderScreen(<ProblemImport />)
  await user.type(screen.getByLabelText('…or paste it here'), 'problems: none')
  await user.click(screen.getByRole('button', { name: 'Preview' }))
  await user.click(await screen.findByRole('button', { name: 'Import 1 problem' }))

  await screen.findByText(/Imported/)
  expect(applied).toBe(1)
})

test('a file already in the bank says there is nothing new, rather than a dead button', async () => {
  server.use(
    http.post('/api/items/import', () =>
      HttpResponse.json({
        applied: false,
        error: null,
        entries: [entry({ action: 'unchanged' })],
      } satisfies Schemas['ImportReportOut']),
    ),
  )
  const { user } = renderScreen(<ProblemImport />)
  await user.type(screen.getByLabelText('…or paste it here'), 'problems: none')
  await user.click(screen.getByRole('button', { name: 'Preview' }))

  expect(await screen.findByText(/already in the bank, unchanged/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Go to the bank' })).toBeInTheDocument()
})

/* --- bulk publish ------------------------------------------------------------------- */

const GOOD = '018f0000-0000-7000-8000-0000000000b1'
const BAD = '018f0000-0000-7000-8000-0000000000b2'

function summary(id: string, title: string): Schemas['ProblemSummaryOut'] {
  return { id, title, difficulty: 1, status: 'draft', version: 1, concept_ids: [], primary_concept_id: null, part_labels: [], test_count: 1, updated_at: '2026-10-04T00:00:00Z' }
}

function problem(id: string, solution: string): Schemas['ProblemOut'] {
  return {
    id, status: 'draft', version: 1, supersedes_id: null, source_key: null,
    updated_at: `2026-10-04T00:00:00.${id.slice(-1)}Z`, parts: [], publish_problems: [],
    document: {
      title: id, prompt_md: '', difficulty: 1, concept_ids: [], primary_concept_id: null,
      starter_code: '', solution_code: solution, hints: [], parts: [],
      tests: [{ kind: 'io', name: 't', hidden: true, stdin: '', expected: '1', match: 'exact' }],
    },
  }
}

test('bulk publish publishes only the drafts whose solutions pass', async () => {
  const published: Record<string, string> = {}
  server.use(
    http.get('/api/items/:id', ({ params }) =>
      HttpResponse.json(problem(params.id as string, params.id === GOOD ? 'print(1)' : 'print(2)')),
    ),
    http.post('/api/items/:id/publish', async ({ params, request }) => {
      published[params.id as string] = ((await request.json()) as Schemas['PublishIn']).verified_updated_at
      return HttpResponse.json(problem(params.id as string, ''))
    }),
  )
  check.mockImplementation(async (code) => ({
    compile_error: null,
    results: [{ name: 't', hidden: false, passed: code === 'print(1)' }],
  }))

  const { user } = renderScreen(<PublishDrafts drafts={[summary(GOOD, 'Good one'), summary(BAD, 'Bad one')]} />)
  await user.click(screen.getByRole('button', { name: 'Check & publish 2 drafts' }))

  await screen.findByText('Published 1 of 2.')
  expect(Object.keys(published)).toEqual([GOOD])
  expect(published[GOOD]).toBe('2026-10-04T00:00:00.1Z')
  expect(screen.getByText(/does not pass every check/)).toBeInTheDocument()
  await waitFor(() => expect(check).toHaveBeenCalledTimes(2))
})
