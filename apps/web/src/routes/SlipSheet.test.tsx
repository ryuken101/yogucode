/**
 * The slips are shown once and cannot be fetched again.
 *
 * The API returns a PIN in plaintext exactly once and stores only an Argon2id hash, so a
 * reload has nothing to recover. The screen has to say that plainly — the failure mode
 * worth preventing is a spinner that never resolves, or worse, a teacher believing the
 * slips are safely stored somewhere.
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
  joinCode: 'WNPXYZ',
  slips: [
    { student_id: 's1', display_name: 'Aria K', pin: '4827' },
    { student_id: 's2', display_name: 'Bella N', pin: '9130' },
  ],
}

test('a slip carries the name, the class code and the PIN', () => {
  renderAt(state)
  expect(screen.getByText('Aria K')).toBeInTheDocument()
  expect(screen.getByText('4827')).toBeInTheDocument()
  expect(screen.getAllByText('WNPXYZ')).toHaveLength(2)
})

test('the teacher is warned that this is the only time they will see them', () => {
  renderAt(state)
  expect(screen.getByText(/cannot be shown again/i)).toBeInTheDocument()
})

test('a reload says the PINs are gone rather than spinning forever', () => {
  renderAt(null)
  expect(screen.getByText(/can’t be shown again/i)).toBeInTheDocument()
  expect(screen.queryByRole('status', { name: /loading/i })).not.toBeInTheDocument()
})

test('the warning is amber, because reissuing is a fix and not a fault', () => {
  renderAt(null)
  const notice = screen.getByText(/can’t be shown again/i)
  expect(notice.className).toContain('amber')
  expect(notice.className).not.toContain('rust')
})
