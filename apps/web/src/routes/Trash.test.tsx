/**
 * The Trash (23 Oct 2026): the teacher's page, a child's Recently deleted, and how a due
 * date is written. The server's rules — who may restore or delete for good — are tested in
 * `apps/api/tests/test_trash.py`; this is what each person sees and can press.
 */

import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, expect, test } from 'vitest'
import { RecentlyDeleted } from '../components/RecentlyDeleted'
import type { Schemas } from '../lib/api'
import { daysLeft, formatDue } from '../lib/dates'
import { renderScreen } from '../test/render'
import { server } from '../test/server'
import { Trash } from './Trash'

const DAY = 86_400_000

function entry(overrides: Partial<Schemas['TrashEntryOut']> = {}): Schemas['TrashEntryOut'] {
  return {
    kind: 'homework',
    id: 'h1',
    name: 'Lists practice',
    detail: 'Homework · Year 4–6 Python',
    deleted_at: new Date(Date.now() - 2 * DAY).toISOString(),
    deleted_by: 'Ken Nguyen',
    purge_after: new Date(Date.now() + 28 * DAY).toISOString(),
    can_purge: true,
    needs_name: false,
    ...overrides,
  }
}

let calls: { path: string; body: unknown }[]

beforeEach(() => {
  calls = []
  server.use(
    http.post('/api/trash/:kind/:id/:action', async ({ request, params }) => {
      calls.push({ path: `${params.kind}/${params.id}/${params.action}`, body: await request.json().catch(() => null) })
      return new HttpResponse(null, { status: 204 })
    }),
  )
})

test('each thing says who deleted it and how long is left, and comes back with Restore', async () => {
  server.use(http.get('/api/trash', () => HttpResponse.json([entry()])))
  const { user } = renderScreen(<Trash />)

  expect(await screen.findByText('Lists practice')).toBeInTheDocument()
  expect(screen.getByText(/Deleted by Ken Nguyen · 28 days left/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Restore' }))
  await waitFor(() => expect(calls.map((c) => c.path)).toEqual(['homework/h1/restore']))
})

test('a class is deleted for good only with its name typed', async () => {
  server.use(
    http.get('/api/trash', () =>
      HttpResponse.json([entry({ kind: 'class', id: 'c1', name: 'TEST class', detail: null, needs_name: true })]),
    ),
  )
  const { user } = renderScreen(<Trash />)
  await user.click(await screen.findByRole('button', { name: 'Delete for good…' }))
  const forGood = screen.getByRole('button', { name: 'Delete for good' })
  expect(forGood).toBeDisabled()

  await user.type(screen.getByLabelText('Type TEST class to confirm'), 'test class')
  await user.click(forGood)
  await waitFor(() => expect(calls).toEqual([{ path: 'class/c1/purge', body: { confirm_name: 'test class' } }]))
})

test('without permission there is Restore but no Delete for good', async () => {
  server.use(http.get('/api/trash', () => HttpResponse.json([entry({ can_purge: false })])))
  renderScreen(<Trash />)
  expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Delete for good…' })).not.toBeInTheDocument()
})

test('a child can put a file back, and never delete it for good', async () => {
  let restored = ''
  server.use(
    http.get('/api/me/trash', () =>
      HttpResponse.json([entry({ kind: 'file', id: 'f1', name: 'game.py', detail: null, can_purge: false })]),
    ),
    http.post('/api/me/trash/:kind/:id/restore', ({ params }) => {
      restored = `${params.kind}/${params.id}`
      return new HttpResponse(null, { status: 204 })
    }),
  )
  const { user } = renderScreen(<RecentlyDeleted alwaysOpen />)
  expect(await screen.findByText('game.py')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /for good/i })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Put back game.py' }))
  await waitFor(() => expect(restored).toBe('file/f1'))
})

test('days left never goes below nothing', () => {
  const now = Date.now()
  expect(daysLeft(new Date(now + 1.5 * DAY).toISOString(), now)).toBe(2)
  expect(daysLeft(new Date(now - DAY).toISOString(), now)).toBe(0)
})

test('a due date shows its year when it is not this one', () => {
  const now = new Date('2026-10-23T00:00:00Z')
  expect(formatDue('2020-01-01T05:00:00Z', now)).toContain('2020')
  expect(formatDue('2026-12-01T05:00:00Z', now)).not.toContain('2026')
})
