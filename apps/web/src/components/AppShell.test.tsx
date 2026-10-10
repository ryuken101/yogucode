/**
 * My code gets the whole window (Ken's feedback, 11 Oct 2026); other teacher pages keep the
 * readable centred column.
 */

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { expect, test } from 'vitest'
import { AppShell } from './AppShell'

function shell(wide: boolean) {
  render(
    <MemoryRouter>
      <AppShell wide={wide}>
        <p>page</p>
      </AppShell>
    </MemoryRouter>,
  )
  return screen.getByRole('main')
}

test('a wide page fills the window instead of the centred column', () => {
  const main = shell(true)
  expect(main.className).not.toContain('max-w-5xl')
  expect(main.className).toContain('flex-1')
})

test('ordinary pages keep the centred column', () => {
  expect(shell(false).className).toContain('max-w-5xl')
})
