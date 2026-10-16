/** The right-click menu (17 Oct 2026): it closes like a menu should, and the keys move in it. */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { ContextMenu, SEPARATOR } from './ContextMenu'

function renderMenu() {
  const onClose = vi.fn()
  const rename = vi.fn()
  render(
    <>
      <p>Outside</p>
      <ContextMenu
        x={10}
        y={10}
        label="stars.py actions"
        onClose={onClose}
        entries={[
          { label: 'Open', onSelect: vi.fn() },
          SEPARATOR,
          { label: 'Paste', disabled: true, onSelect: vi.fn() },
          { label: 'Rename', onSelect: rename },
        ]}
      />
    </>,
  )
  return { onClose, rename, user: userEvent.setup() }
}

test('the first item is focused, arrows skip what is disabled, and a choice closes it', async () => {
  const { onClose, rename, user } = renderMenu()
  expect(screen.getByRole('menuitem', { name: 'Open' })).toHaveFocus()
  await user.keyboard('{ArrowDown}')
  expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus()
  await user.keyboard('{Enter}')
  expect(rename).toHaveBeenCalled()
  expect(onClose).toHaveBeenCalled()
})

test('Escape and a press outside close it', async () => {
  const { onClose, user } = renderMenu()
  await user.keyboard('{Escape}')
  expect(onClose).toHaveBeenCalledTimes(1)
  await user.click(screen.getByText('Outside'))
  expect(onClose).toHaveBeenCalledTimes(2)
})
