/**
 * Show PIN (Ken's decision, 16 Oct 2026): hidden until asked for, hidden again on its own,
 * and a PIN that cannot be revealed says how to fix it rather than looking like a fault.
 */

import { act, fireEvent, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, test, vi } from 'vitest'
import { renderScreen } from '../test/render'
import { ARIA_ID, ARIA_PIN, ARIA_USERNAME, server } from '../test/server'
import { SHOW_PIN_SECONDS, ShowPin } from './ShowPin'

afterEach(() => vi.useRealTimers())

function revealing() {
  let calls = 0
  server.use(
    http.post(`/api/students/${ARIA_ID}/pin/reveal`, () => {
      calls += 1
      return HttpResponse.json({
        student_id: ARIA_ID,
        display_name: 'Aria K',
        username: ARIA_USERNAME,
        pin: ARIA_PIN,
      })
    }),
  )
  return () => calls
}

test('the PIN is hidden until asked for, then shown', async () => {
  const calls = revealing()
  const { user } = renderScreen(<ShowPin studentId={ARIA_ID} name="Aria K" viewable />)
  expect(screen.queryByText(ARIA_PIN)).not.toBeInTheDocument()
  expect(calls()).toBe(0)

  await user.click(screen.getByRole('button', { name: 'Show Aria K’s PIN' }))
  expect(await screen.findByLabelText('Aria K’s PIN')).toHaveTextContent(ARIA_PIN)
  expect(calls()).toBe(1)
})

test('a second press hides it again', async () => {
  revealing()
  const { user } = renderScreen(<ShowPin studentId={ARIA_ID} name="Aria K" viewable />)
  await user.click(screen.getByRole('button', { name: 'Show Aria K’s PIN' }))
  await screen.findByText(ARIA_PIN)
  await user.click(screen.getByRole('button', { name: 'Hide Aria K’s PIN' }))
  expect(screen.queryByText(ARIA_PIN)).not.toBeInTheDocument()
})

test('it hides itself after half a minute', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  revealing()
  renderScreen(<ShowPin studentId={ARIA_ID} name="Aria K" viewable />)
  fireEvent.click(screen.getByRole('button', { name: 'Show Aria K’s PIN' }))
  await screen.findByText(ARIA_PIN)

  act(() => vi.advanceTimersByTime(SHOW_PIN_SECONDS * 1000))
  expect(screen.queryByText(ARIA_PIN)).not.toBeInTheDocument()
})

test('a PIN set before Show PIN says how to make it viewable, in muted text', () => {
  revealing()
  renderScreen(<ShowPin studentId={ARIA_ID} name="Aria K" viewable={false} />)
  expect(screen.queryByRole('button', { name: /show/i })).not.toBeInTheDocument()
  const note = screen.getByText(/change pin to make it viewable/i)
  expect(note.className).toContain('text-muted')
  expect(note.className).not.toContain('system-error')
})
