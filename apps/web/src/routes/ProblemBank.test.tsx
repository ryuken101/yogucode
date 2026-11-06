/**
 * The bank in categories: it sorts itself by concept, folders are the teachers' own, and the
 * builders choose from the same thing.
 */

import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { beforeEach, expect, test } from 'vitest'
import type { Schemas } from '../lib/api'
import { ProblemListEditor, type ProblemRow } from '../problems/ProblemListEditor'
import { renderScreen } from '../test/render'
import { server } from '../test/server'
import { ProblemBank } from './ProblemBank'

const LOOPS = '018f0000-0000-7000-8000-00000000c001'
const LISTS = '018f0000-0000-7000-8000-00000000c002'
const UNUSED = '018f0000-0000-7000-8000-00000000c003'
const FOLDER = '018f0000-0000-7000-8000-00000000f001'

function problem(id: string, title: string, overrides: Partial<Schemas['ProblemSummaryOut']> = {}) {
  return {
    id: `018f0000-0000-7000-8000-0000000000${id}`,
    kind: 'code',
    title,
    difficulty: 1,
    status: 'published',
    version: 1,
    concept_ids: [],
    primary_concept_id: null,
    part_labels: [],
    test_count: 1,
    folder_ids: [],
    updated_at: '2026-10-01T00:00:00Z',
    ...overrides,
  } satisfies Schemas['ProblemSummaryOut']
}

const countdown = problem('a1', 'Countdown', { concept_ids: [LOOPS], primary_concept_id: LOOPS, difficulty: 2 })
const both = problem('a2', 'Loop over a list', {
  concept_ids: [LOOPS, LISTS],
  primary_concept_id: LOOPS,
  folder_ids: [FOLDER],
})
const shopping = problem('a3', 'Shopping list', { concept_ids: [LISTS], primary_concept_id: LISTS })
const untagged = problem('a4', 'Half written', { status: 'draft' })
const old = problem('a5', 'Old one', { status: 'archived', concept_ids: [LISTS] })

let added: { folder: string; items: string[] }[]

beforeEach(() => {
  added = []
  window.localStorage.clear()
  server.use(
    http.get('/api/concepts', () =>
      HttpResponse.json([
        { id: LOOPS, key: 'loops', label: 'For loops', parent_id: null, sort_order: 10, status: 'active', description: null },
        { id: LISTS, key: 'lists', label: 'Lists', parent_id: null, sort_order: 20, status: 'active', description: null },
        { id: UNUSED, key: 'turtle', label: 'Turtle basics', parent_id: null, sort_order: 30, status: 'active', description: null },
      ]),
    ),
    http.get('/api/items', ({ request }) => {
      const statuses = new URL(request.url).searchParams.getAll('status')
      const all = [countdown, both, shopping, untagged, old]
      return HttpResponse.json(all.filter((p) => statuses.includes(p.status)))
    }),
    http.get('/api/problem-folders', () =>
      HttpResponse.json([{ id: FOLDER, name: 'Term 4 quizzes', updated_at: '2026-10-01T00:00:00Z' }]),
    ),
    http.post(`/api/problem-folders/${FOLDER}/items`, async ({ request }) => {
      const body = (await request.json()) as { item_ids: string[] }
      added.push({ folder: FOLDER, items: body.item_ids })
      return new HttpResponse(null, { status: 204 })
    }),
  )
})

const sidebar = async () => within(await screen.findByRole('navigation', { name: 'Categories', hidden: true }))
const category = (nav: Awaited<ReturnType<typeof sidebar>>, name: RegExp) =>
  nav.getByRole('button', { name, hidden: true })

test('categories show their counts, and only the concepts in use', async () => {
  renderScreen(<ProblemBank />)
  const nav = await sidebar()
  await waitFor(() => expect(category(nav, /^All problems\s*4$/)).toBeInTheDocument())
  expect(category(nav, /^Needs a concept\s*1$/)).toBeInTheDocument()
  expect(category(nav, /^Archived\s*1$/)).toBeInTheDocument()
  expect(category(nav, /^For loops\s*2$/)).toBeInTheDocument()
  expect(category(nav, /^Term 4 quizzes\s*1$/)).toBeInTheDocument()
  expect(nav.queryByText('Turtle basics')).not.toBeInTheDocument()
})

test('a problem with two concepts is under both', async () => {
  const { user } = renderScreen(<ProblemBank />)
  const nav = await sidebar()
  await user.click(await nav.findByRole('button', { name: /^For loops/, hidden: true }))
  expect(await screen.findByRole('link', { name: /Loop over a list/ })).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: /Shopping list/ })).not.toBeInTheDocument()
  await user.click(category(nav, /^Lists/))
  expect(await screen.findByRole('link', { name: /Loop over a list/ })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /Shopping list/ })).toBeInTheDocument()
})

test('search works inside a category and the counts follow it', async () => {
  const { user } = renderScreen(<ProblemBank />)
  const nav = await sidebar()
  await user.click(await nav.findByRole('button', { name: /^Lists/, hidden: true }))
  await user.type(screen.getByLabelText('Search titles'), 'countdown')
  expect(await screen.findByText('No problems match')).toBeInTheDocument()
  expect(category(nav, /^All problems\s*1$/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Look in all problems' }))
  expect(await screen.findByRole('link', { name: /Countdown/ })).toBeInTheDocument()
})

test('ticking problems and choosing a folder adds them', async () => {
  const { user } = renderScreen(<ProblemBank />)
  await user.click(await screen.findByRole('checkbox', { name: 'Select Countdown' }))
  await user.click(screen.getByRole('checkbox', { name: 'Select Shopping list' }))
  expect(screen.getByText('2 selected')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Add to folder' }))
  await user.click(screen.getByRole('menuitem', { name: 'Term 4 quizzes' }))
  await waitFor(() => expect(added).toEqual([{ folder: FOLDER, items: [countdown.id, shopping.id] }]))
  expect(await screen.findByText('Added 2 to Term 4 quizzes.')).toBeInTheDocument()
})

test('a remembered category that has gone falls back to all problems', async () => {
  window.localStorage.setItem('yogucode-bank-category', 'folder:018f0000-0000-7000-8000-00000000ffff')
  renderScreen(<ProblemBank />)
  expect(await screen.findByRole('heading', { name: 'All problems' })).toBeInTheDocument()
})

/* --- the builders' picker --------------------------------------------------------------- */

function Builder({ limit = 3, initial = [] as ProblemRow[] }) {
  const [rows, setRows] = useState<ProblemRow[]>(initial)
  return <ProblemListEditor rows={rows} onChange={setRows} empty="Nothing yet." limit={limit} />
}

const onList: ProblemRow = {
  id: countdown.id, title: 'Countdown', difficulty: 2, newerVersionId: null, superseded: false,
}

test('the picker adds what was ticked, in the order ticked, published only', async () => {
  const { user } = renderScreen(<Builder />)
  await user.click(screen.getByRole('button', { name: 'Add problems' }))
  const shoppingBox = await screen.findByRole('checkbox', { name: /Shopping list/, hidden: true })
  expect(screen.queryByText('Half written')).not.toBeInTheDocument()
  await user.click(shoppingBox)
  await user.click(screen.getByRole('checkbox', { name: /Countdown/, hidden: true }))
  await user.click(screen.getByRole('button', { name: 'Add 2 problems', hidden: true }))
  const rows = await screen.findAllByRole('listitem')
  expect(rows[0]).toHaveTextContent('Shopping list')
  expect(rows[1]).toHaveTextContent('Countdown')
})

test('the picker marks what is on the list and stops at the limit', async () => {
  const { user } = renderScreen(<Builder limit={2} initial={[onList]} />)
  await user.click(screen.getByRole('button', { name: 'Add problems' }))
  const there = await screen.findByRole('checkbox', { name: /Countdown/, hidden: true })
  expect(there).toBeChecked()
  expect(there).toBeDisabled()
  await user.click(screen.getByRole('checkbox', { name: /Shopping list/, hidden: true }))
  expect(screen.getByRole('checkbox', { name: /Loop over a list/, hidden: true })).toBeDisabled()
  expect(screen.getByText(/most this list can hold \(2\)/)).toBeInTheDocument()
})

test('a full list says so instead of opening the picker', () => {
  renderScreen(<Builder limit={1} initial={[onList]} />)
  expect(screen.getByRole('button', { name: 'Add problems' })).toBeDisabled()
  expect(screen.getByText(/This list is full/)).toBeInTheDocument()
})
