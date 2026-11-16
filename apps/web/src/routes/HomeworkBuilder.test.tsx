/**
 * A set homework's problems can still change (Ken, 16 Nov 2026). Children see a change at
 * once, so it is confirmed first, and the confirmation says what will happen to their work.
 */

import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { expect, test } from 'vitest'
import type { Schemas } from '../lib/api'
import { renderScreen } from '../test/render'
import { server } from '../test/server'
import { HomeworkBuilder } from './HomeworkBuilder'

const CLASS = '018f0000-0000-7000-8000-000000000001'
const HW = '018f0000-0000-7000-8000-0000000000a1'
const P1 = '018f0000-0000-7000-8000-0000000000b1'
const P2 = '018f0000-0000-7000-8000-0000000000b2'
const P1_V2 = '018f0000-0000-7000-8000-0000000000b3'

function problem(id: string, title: string, newer: string | null = null): Schemas['HomeworkProblemOut'] {
  return { id, title, difficulty: 1, status: 'published', newer_version_id: newer }
}

function homework(overrides: Partial<Schemas['HomeworkOut']> = {}): Schemas['HomeworkOut'] {
  return {
    id: HW, class_id: CLASS, title: 'Lists practice', status: 'open', due_at: '2099-10-16T05:00:00Z',
    hints: true, released_at: null, problems: [problem(P1, 'Add to the end'), problem(P2, 'Countdown')],
    students: 5, handed_in: 2, marked: 0, returned: 0,
    ...overrides,
  }
}

function renderBuilder(data: Schemas['HomeworkOut'], onPatch: (body: Schemas['HomeworkPatch']) => void) {
  server.use(
    http.get(`/api/assignments/${HW}`, () => HttpResponse.json(data)),
    http.get(`/api/classes/${CLASS}`, () => HttpResponse.json({ id: CLASS, name: 'Year 4-6', term_label: null,
      status: 'active', course_id: null, current_lesson_id: null, join_code: 'X',
      created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' })),
    http.get('/api/items', () => HttpResponse.json([])),
    http.patch(`/api/assignments/${HW}`, async ({ request }) => {
      onPatch((await request.json()) as Schemas['HomeworkPatch'])
      return HttpResponse.json(data)
    }),
  )
  return renderScreen(
    <Routes>
      <Route path="/classes/:classId/homework/:assignmentId" element={<HomeworkBuilder />} />
    </Routes>,
    { route: `/classes/${CLASS}/homework/${HW}` },
  )
}

test('a set homework’s problems can be removed, after a confirmation that says the work is kept', async () => {
  let patched: Schemas['HomeworkPatch'] | null = null
  const { user } = renderBuilder(homework(), (body) => (patched = body))

  const rows = await screen.findAllByRole('listitem')
  await user.click(within(rows[0]!).getByRole('button', { name: 'Remove' }))
  await user.click(screen.getByRole('button', { name: 'Save changes' }))

  expect(patched).toBeNull()
  const confirm = await screen.findByText('Change the problems on a homework students already have?')
  const box = confirm.parentElement!
  expect(within(box).getByText(/kept, and comes back if you add the problem again/)).toBeInTheDocument()
  expect(within(box).queryByText(/hand in again/)).not.toBeInTheDocument()

  await user.click(within(box).getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(patched).not.toBeNull())
  expect(patched!.item_ids).toEqual([P2])
})

test('swapping in a newer version warns about hand-ins and children whose work is back', async () => {
  let patched: Schemas['HomeworkPatch'] | null = null
  const { user } = renderBuilder(
    homework({ problems: [problem(P1, 'Add to the end', P1_V2)], returned: 2 }),
    (body) => (patched = body),
  )

  await user.click(await screen.findByRole('button', { name: 'Use the newer version' }))
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  const box = (await screen.findByText('Change the problems on a homework students already have?')).parentElement!
  expect(within(box).getByText(/asked to hand in again/)).toBeInTheDocument()
  expect(within(box).getByText(/2 students already have their work back/)).toBeInTheDocument()

  await user.click(within(box).getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(patched).not.toBeNull())
  expect(patched!.item_ids).toEqual([P1_V2])
})

test('changing only the title of a set homework saves without asking', async () => {
  let patched: Schemas['HomeworkPatch'] | null = null
  const { user } = renderBuilder(homework(), (body) => (patched = body))

  const title = await screen.findByLabelText('Title')
  await user.type(title, '!')
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(patched).not.toBeNull())
  expect(patched!.title).toBe('Lists practice!')
  expect(screen.queryByText(/already have\?/)).not.toBeInTheDocument()
})
