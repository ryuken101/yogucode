/**
 * The child's home: homework cards that answer "when is it due, how far am I, have I
 * handed it in", and today's ladder.
 */

import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { expect, test } from 'vitest'
import type { Schemas } from '../lib/api'
import { renderScreen } from '../test/render'
import { server } from '../test/server'
import { MyWork } from './MyWork'
import { StudentHome } from './StudentHome'

const ASSIGNMENT = '018f0000-0000-7000-8000-0000000000d1'
const ITEM = '018f0000-0000-7000-8000-0000000000d2'

const today: Schemas['TodayOut'] = {
  class_name: 'Year 4-6 Python',
  lesson_title: 'Append',
  assignment_id: ASSIGNMENT,
  problems: [
    { item_id: ITEM, title: 'Add to the end', difficulty: 1, part_labels: [], progress: 'passing' },
    { item_id: 'x', title: 'Shopping list', difficulty: 2, part_labels: ['a', 'b'], progress: 'not_started' },
  ],
}

function card(overrides: Partial<Schemas['HomeworkCardOut']>): Schemas['HomeworkCardOut'] {
  return {
    assignment_id: '018f0000-0000-7000-8000-0000000000f1',
    mode: 'homework',
    title: 'Lists practice',
    due_at: '2099-10-16T05:00:00Z',
    closed: false,
    problems: 3,
    started: 1,
    handed_in_at: null,
    changed_since_hand_in: false,
    late: false,
    returned: false,
    ...overrides,
  }
}

function serve(home: Schemas['HomeOut']) {
  server.use(http.get('/api/me/home', () => HttpResponse.json(home)))
}

test('home lists the ladder with progress, linking to each problem', async () => {
  serve({ today, homework: [] })
  renderScreen(<StudentHome />, { route: '/home' })

  expect(await screen.findByRole('heading', { name: 'Append' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /Add to the end/ })).toHaveAttribute(
    'href',
    `/lesson/${ASSIGNMENT}/${ITEM}`,
  )
  expect(screen.getByText('All checks pass')).toBeInTheDocument()
  expect(screen.getByText('2 parts')).toBeInTheDocument()
})

test('home says so when nothing is set', async () => {
  serve({
    today: { class_name: 'Year 4-6 Python', lesson_title: null, assignment_id: null, problems: [] },
    homework: [],
  })
  renderScreen(<StudentHome />, { route: '/home' })
  expect(await screen.findByText('Nothing set for today yet')).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Homework' })).not.toBeInTheDocument()
})

test('a homework card says when it is due and how far they have got', async () => {
  serve({ today, homework: [card({})] })
  // Homework is the Work app's since the desktop (16 Oct 2026).
  renderScreen(<MyWork />, { route: '/my-work' })

  const link = await screen.findByRole('link', { name: /Lists practice/ })
  expect(link).toHaveAttribute('href', '/homework/018f0000-0000-7000-8000-0000000000f1')
  expect(link).toHaveTextContent(/Due \w{3}, 16 Oct/)
  expect(link).toHaveTextContent('1 of 3 started')
})

test('handed in, changed since, and given back each say so — never in system-error', async () => {
  serve({
    today,
    homework: [
      card({ assignment_id: 'a', title: 'One', handed_in_at: '2026-10-07T00:00:00Z' }),
      card({ assignment_id: 'b', title: 'Two', handed_in_at: '2026-10-07T00:00:00Z', changed_since_hand_in: true }),
      card({ assignment_id: 'c', title: 'Three', returned: true }),
      card({ assignment_id: 'd', title: 'Four', due_at: '2020-01-01T00:00:00Z' }),
    ],
  })
  renderScreen(<MyWork />, { route: '/my-work' })

  expect(await screen.findByText('Handed in')).toBeInTheDocument()
  expect(screen.getByText('Changed since you handed in')).toBeInTheDocument()
  expect(screen.getByText('Feedback is back')).toBeInTheDocument()
  const late = screen.getByText('Past the due date')
  expect(late.className).toContain('not-yet')
  expect(document.body.innerHTML).not.toContain('system-error')
})
