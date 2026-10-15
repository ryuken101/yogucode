/**
 * The sheet is shown once and is not fetched again.
 *
 * Show PIN reveals one child's PIN at a time (16 Oct 2026); a whole sheet is never fetched
 * back, so a reload has nothing to recover. The screen has to say that plainly, and say
 * where to look instead — the failure mode worth preventing is a spinner that never
 * resolves.
 */

import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { expect, test } from 'vitest'
import { SlipSheet } from './SlipSheet'
import type { SlipState } from './SlipSheet'

function renderAt(state: SlipState | null) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/classes/c1/slips', state }]}>
      <Routes>
        <Route path="/classes/:classId/slips" element={<SlipSheet />} />
      </Routes>
    </MemoryRouter>,
  )
}

const state: SlipState = {
  className: 'Year 4-6 Python',
  slips: [
    { student_id: 's1', display_name: 'Aria K', username: 'aria.k', pin: '4827' },
    { student_id: 's2', display_name: 'Bella N', username: 'bella.n', pin: '9130' },
  ],
}

test('a slip carries the name, the username and the PIN — the whole login', () => {
  renderAt(state)
  expect(screen.getByText('Aria K')).toBeInTheDocument()
  expect(screen.getByText('aria.k')).toBeInTheDocument()
  expect(screen.getByText('4827')).toBeInTheDocument()
  expect(screen.queryByText('WNPXYZ')).not.toBeInTheDocument()
})

test('the teacher is told to print now, and where to look a PIN up later', () => {
  renderAt(state)
  expect(screen.getByText(/print these now/i)).toHaveTextContent(/show pin/i)
})

test('a reload says the PINs are gone rather than spinning forever', () => {
  renderAt(null)
  expect(screen.getByText(/can’t be shown again/i)).toHaveTextContent(/show pin/i)
  expect(screen.queryByRole('status', { name: /loading/i })).not.toBeInTheDocument()
})

test('the warning is not-yet, because reissuing is a fix and not a fault', () => {
  renderAt(null)
  const notice = screen.getByText(/can’t be shown again/i)
  expect(notice.className).toContain('not-yet')
  expect(notice.className).not.toContain('system-error')
})

test('a slip tells the child which address to type', () => {
  renderAt(state)
  expect(screen.getAllByText('Go to')).toHaveLength(2)
  expect(screen.getAllByText(window.location.host)).toHaveLength(2)
})
