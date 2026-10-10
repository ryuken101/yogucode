/**
 * The file explorer (Ken's decision, 11 Oct 2026): folders nest, files open, new things go
 * into the selected folder, rename on double-click, delete asks first, and dragging moves.
 */

import { createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import type { Schemas } from '../lib/api'
import { FileExplorer } from './FileExplorer'

const at = '2026-10-11T00:00:00Z'
const folder = (id: string, name: string, parent_id: string | null = null): Schemas['FolderOut'] => ({
  id, name, parent_id, created_at: at, updated_at: at,
})
const file = (id: string, title: string, folder_id: string | null = null): Schemas['DocumentSummaryOut'] => ({
  id, title, folder_id, status: 'active', created_at: at, updated_at: at,
})

const FOLDERS = [folder('w1', 'week 1'), folder('loops', 'loops', 'w1'), folder('w2', 'week 2')]
const FILES = [file('sq', 'squares', 'loops'), file('top', 'scratch')]

function setup(overrides: Partial<Parameters<typeof FileExplorer>[0]> = {}) {
  const props = {
    files: FILES,
    folders: FOLDERS,
    activeId: null,
    onOpen: vi.fn(),
    onCreateFile: vi.fn(),
    onCreateFolder: vi.fn(),
    onRenameFile: vi.fn(),
    onRenameFolder: vi.fn(),
    onMove: vi.fn(),
    onDeleteFile: vi.fn(),
    onDeleteFolder: vi.fn(),
    ...overrides,
  }
  render(<FileExplorer {...props} />)
  return { props, user: userEvent.setup(), tree: screen.getByRole('tree') }
}

test('folders open to show what is inside; files open when clicked', async () => {
  const { props, user, tree } = setup()
  expect(within(tree).queryByRole('button', { name: 'loops' })).not.toBeInTheDocument()
  await user.click(within(tree).getByRole('button', { name: 'week 1' }))
  await user.click(within(tree).getByRole('button', { name: 'loops' }))
  await user.click(within(tree).getByRole('button', { name: 'squares' }))
  expect(props.onOpen).toHaveBeenCalledWith('sq')
})

test('the open file’s folders are shown open, so you can see where you are', () => {
  const { tree } = setup({ activeId: 'sq' })
  expect(within(tree).getByRole('button', { name: 'squares' })).toBeInTheDocument()
})

test('new files and folders go into the selected folder', async () => {
  const { props, user, tree } = setup()
  await user.click(within(tree).getByRole('button', { name: 'week 2' }))
  await user.click(screen.getByRole('button', { name: 'New file' }))
  expect(props.onCreateFile).toHaveBeenCalledWith('w2')

  await user.click(screen.getByRole('button', { name: 'New folder' }))
  await user.type(screen.getByLabelText('New folder name'), 'shapes{Enter}')
  expect(props.onCreateFolder).toHaveBeenCalledWith('shapes', 'w2')
})

test('with nothing selected, new things go at the top', async () => {
  const { props, user } = setup()
  await user.click(screen.getByRole('button', { name: 'New folder' }))
  await user.type(screen.getByLabelText('New folder name'), 'week 3{Enter}')
  expect(props.onCreateFolder).toHaveBeenCalledWith('week 3', null)
})

test('double-click renames; Escape cancels', async () => {
  const { props, user, tree } = setup()
  await user.dblClick(within(tree).getByRole('button', { name: 'scratch' }))
  const box = screen.getByLabelText('Rename scratch')
  await user.clear(box)
  await user.type(box, 'demo{Enter}')
  expect(props.onRenameFile).toHaveBeenCalledWith('top', 'demo')

  await user.dblClick(within(tree).getByRole('button', { name: 'week 2' }))
  await user.type(screen.getByLabelText('Rename week 2'), 'x{Escape}')
  expect(props.onRenameFolder).not.toHaveBeenCalled()
})

test('deleting asks first, and says what goes with a folder', async () => {
  const { props, user } = setup()
  await user.click(screen.getByRole('button', { name: 'Delete week 1' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText(/everything inside it/)).toBeInTheDocument()
  expect(props.onDeleteFolder).not.toHaveBeenCalled()
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
  expect(props.onDeleteFolder).toHaveBeenCalledWith('w1')
})

function drag(source: HTMLElement, target: HTMLElement) {
  const store = new Map<string, string>()
  const dataTransfer = {
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
    get types() {
      return [...store.keys()]
    },
    effectAllowed: 'move',
  }
  fireEvent.dragStart(source, { dataTransfer })
  const over = createEvent.dragOver(target, { dataTransfer })
  fireEvent(target, over)
  fireEvent.drop(target, { dataTransfer })
}

test('dragging a file onto a folder moves it there', () => {
  const { props, tree } = setup()
  const scratch = within(tree).getByRole('button', { name: 'scratch' }).parentElement!
  const week2 = within(tree).getByRole('button', { name: 'week 2' }).parentElement!
  drag(scratch, week2)
  expect(props.onMove).toHaveBeenCalledWith({ kind: 'file', id: 'top' }, 'w2')
})

test('dragging a folder onto "Files" brings it to the top level', () => {
  const { props, tree } = setup({ activeId: 'sq' })
  const loops = within(tree).getByRole('button', { name: 'loops' }).parentElement!
  const top = screen.getByText('Files').parentElement!
  drag(loops, top)
  expect(props.onMove).toHaveBeenCalledWith({ kind: 'folder', id: 'loops' }, null)
})

// --- moving out of folders (Ken's feedback, 11 Oct 2026) ------------------------------------

test('dropping a file on empty space in the list moves it out to the top level', () => {
  const { props, tree } = setup({ activeId: 'sq' })
  const squares = within(tree).getByRole('button', { name: 'squares' }).parentElement!
  drag(squares, tree)
  expect(props.onMove).toHaveBeenCalledWith({ kind: 'file', id: 'sq' }, null)
})

test('dropping on a top-level file moves it out to the top level too', () => {
  const { props, tree } = setup({ activeId: 'sq' })
  const squares = within(tree).getByRole('button', { name: 'squares' }).parentElement!
  const scratch = within(tree).getByRole('button', { name: 'scratch' }).parentElement!
  drag(squares, scratch)
  expect(props.onMove).toHaveBeenCalledWith({ kind: 'file', id: 'sq' }, null)
})

test('dropping on a file inside a folder moves it into that folder', () => {
  const { props, tree } = setup({ activeId: 'sq' })
  const scratch = within(tree).getByRole('button', { name: 'scratch' }).parentElement!
  const squares = within(tree).getByRole('button', { name: 'squares' }).parentElement!
  drag(scratch, squares)
  expect(props.onMove).toHaveBeenCalledWith({ kind: 'file', id: 'top' }, 'loops')
})

test('dropping where it already is, or a folder inside itself, does nothing', () => {
  const { props, tree } = setup({ activeId: 'sq' })
  const scratch = within(tree).getByRole('button', { name: 'scratch' }).parentElement!
  drag(scratch, tree) // already at the top
  const week1 = within(tree).getByRole('button', { name: 'week 1' }).parentElement!
  const loops = within(tree).getByRole('button', { name: 'loops' }).parentElement!
  drag(week1, loops) // into its own child
  expect(props.onMove).not.toHaveBeenCalled()
})

test('Move to… moves without dragging — into a folder, or out to the top', async () => {
  const { props, user } = setup({ activeId: 'sq' })
  await user.click(screen.getByRole('button', { name: 'Move squares' }))
  let dialog = screen.getByRole('dialog')
  expect(within(dialog).getByRole('option', { name: 'week 1 / loops' })).toBeInTheDocument()
  await user.selectOptions(within(dialog).getByLabelText('Move to'), 'w2')
  await user.click(within(dialog).getByRole('button', { name: 'Move' }))
  expect(props.onMove).toHaveBeenLastCalledWith({ kind: 'file', id: 'sq' }, 'w2')

  await user.click(screen.getByRole('button', { name: 'Move squares' }))
  dialog = screen.getByRole('dialog')
  await user.selectOptions(within(dialog).getByLabelText('Move to'), 'Top level (no folder)')
  await user.click(within(dialog).getByRole('button', { name: 'Move' }))
  expect(props.onMove).toHaveBeenLastCalledWith({ kind: 'file', id: 'sq' }, null)
})

test('a folder cannot be offered a place inside itself', async () => {
  const { user } = setup()
  await user.click(screen.getByRole('button', { name: 'Move week 1' }))
  const options = within(screen.getByRole('dialog')).getAllByRole('option').map((o) => o.textContent)
  expect(options).toEqual(['Top level (no folder)', 'week 2'])
})

test('every icon button keeps a name a screen reader can say', () => {
  setup()
  for (const name of ['New file', 'New folder', 'Edit name of scratch', 'Move scratch', 'Delete scratch']) {
    expect(screen.getByRole('button', { name })).toBeInTheDocument()
  }
})
