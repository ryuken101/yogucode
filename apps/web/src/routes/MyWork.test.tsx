/**
 * My work's Lessons tab (17 Oct 2026): lesson problems a child has started, by lesson, so
 * one from an earlier lesson can be finished at home.
 */

import { screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { expect, test } from 'vitest'
import type { Schemas } from '../lib/api'
import { renderScreen } from '../test/render'
import { server } from '../test/server'
import { MyWork } from './MyWork'

const at = '2026-10-16T00:00:00Z'
const started: Schemas['StartedProblemOut'][] = [
  { assignment_id: 'l2', item_id: 'p3', lesson_title: 'Loops', title: 'Count down', part_labels: [], progress: 'started', updated_at: at },
  { assignment_id: 'l1', item_id: 'p1', lesson_title: 'Lists', title: 'Times tables', part_labels: ['a', 'b'], progress: 'passing', updated_at: at },
]

function renderLessons() {
  return renderScreen(
    <Routes>
      <Route path="/my-work" element={<MyWork />} />
    </Routes>,
    { route: '/my-work?tab=lessons' },
  )
}

test('started lesson problems are listed by lesson, and open where they are worked', async () => {
  server.use(http.get('/api/me/problems', () => HttpResponse.json(started)))
  renderLessons()
  const lists = within(await screen.findByRole('region', { name: 'Lists' }))
  const link = lists.getByRole('link', { name: /Times tables/ })
  expect(link).toHaveAttribute('href', '/lesson/l1/p1')
  expect(lists.getByText('Parts (a) (b)')).toBeInTheDocument()
  expect(lists.getByText('All checks passing')).toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Loops' })).toHaveTextContent('Keep going')
})

test('nothing started yet says where work will show up', async () => {
  server.use(http.get('/api/me/problems', () => HttpResponse.json([])))
  renderLessons()
  expect(await screen.findByText('No lesson work yet')).toBeInTheDocument()
})
