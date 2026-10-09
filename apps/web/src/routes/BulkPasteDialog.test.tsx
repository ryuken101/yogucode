/**
 * Bulk paste — the flow the phase plan calls a buy-in risk in its own right.
 *
 * "Twelve students added one modal at a time is a bad first impression on the person whose
 * buy-in the project depends on." So this is the teacher-facing equivalent of the join
 * flow: the screen where getting it wrong costs the most, and therefore the one that
 * should not rely on having been clicked through once by hand.
 */

import { screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { BulkPasteDialog } from './BulkPasteDialog'
import { renderScreen } from '../test/render'
import { AIDEN_ONE, CLASS_ID, bulkRefused, cleanPreview, countCommits, server } from '../test/server'

function open(onClose = vi.fn()) {
  return {
    onClose,
    ...renderScreen(<BulkPasteDialog classId={CLASS_ID} open onClose={onClose} />),
  }
}

/** Paste names and get to the verdict table. */
async function preview(user: ReturnType<typeof renderScreen>['user']) {
  await user.type(screen.getByLabelText('One name per line'), 'Chen W')
  await user.click(screen.getByRole('button', { name: 'Check names' }))
  await screen.findByRole('button', { name: /^Add / })
}

test('the preview writes nothing until the teacher confirms', async () => {
  const { calls, handler } = countCommits()
  server.use(handler)
  const { user } = open()

  await user.type(screen.getByLabelText('One name per line'), 'Chen W')
  await user.click(screen.getByRole('button', { name: 'Check names' }))
  await screen.findByText('New student')

  // This is the whole reason the paste is two requests rather than one.
  expect(calls).toHaveLength(0)
})

test('every verdict gets a row the teacher can read', async () => {
  const { user } = open()
  await preview(user)

  // One row per PasteAction, in the order the API returned them.
  expect(screen.getByText('New student')).toBeInTheDocument()
  expect(screen.getByText('Already at the centre')).toBeInTheDocument()
  expect(screen.getByText('Already in this class')).toBeInTheDocument()
  expect(screen.getByText('Which one?')).toBeInTheDocument()
  expect(screen.getByText('Listed twice')).toBeInTheDocument()
  expect(screen.getByText('Cannot use')).toBeInTheDocument()
})

test('a mis-paste is not-yet, never system-error — it is not a system error', async () => {
  const { user } = open()
  await preview(user)

  for (const label of ['Which one?', 'Listed twice', 'Cannot use']) {
    expect(screen.getByText(label).className).toContain('not-yet')
    expect(screen.getByText(label).className).not.toContain('system-error')
  }
  expect(document.body.innerHTML).not.toContain('system-error')
})

test('unresolved rows block the commit and say how many', async () => {
  const { user } = open()
  await preview(user)

  // ambiguous + duplicate_in_paste + invalid = 3 rows needing a decision.
  expect(screen.getByText(/3 rows still need a decision/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /^Add / })).toBeDisabled()
})

test('picking which child unblocks the ambiguous row', async () => {
  const { user } = open()
  await preview(user)

  await user.selectOptions(screen.getByRole('combobox'), AIDEN_ONE)

  // One fewer blocker; the other two still hold it shut.
  expect(screen.getByText(/2 rows still need a decision/)).toBeInTheDocument()
})

test('an already-enrolled row is not counted as something to add', async () => {
  const { user } = open()
  await preview(user)

  // 6 rows: 3 blocking, 1 already enrolled, leaving 2 that would actually be added.
  expect(screen.getByRole('button', { name: 'Add 2' })).toBeInTheDocument()
})

test('editing the list returns to the textarea with the paste intact', async () => {
  const { user } = open()
  await preview(user)

  await user.click(screen.getByRole('button', { name: 'Edit the list' }))

  expect(screen.getByLabelText('One name per line')).toHaveValue('Chen W')
  expect(screen.queryByText('New student')).not.toBeInTheDocument()
})

test('a clean paste commits every row and closes', async () => {
  server.use(cleanPreview())
  const { calls, handler } = countCommits()
  server.use(handler)
  const onClose = vi.fn()
  const { user } = open(onClose)

  await user.type(screen.getByLabelText('One name per line'), 'Chen W\nDara P')
  await user.click(screen.getByRole('button', { name: 'Check names' }))
  await user.click(await screen.findByRole('button', { name: 'Add 2' }))

  await waitFor(() => expect(onClose).toHaveBeenCalled())
  expect(calls).toHaveLength(1)
  expect(calls[0]?.entries).toEqual([
    { display_name: 'Chen W', student_id: null },
    { display_name: 'Dara P', student_id: null },
  ])
})

test('an all-or-nothing refusal keeps the dialog open and names the rows', async () => {
  server.use(cleanPreview(), bulkRefused())
  const onClose = vi.fn()
  const { user } = open(onClose)

  await user.type(screen.getByLabelText('One name per line'), 'Chen W\nDara P')
  await user.click(screen.getByRole('button', { name: 'Check names' }))
  await user.click(await screen.findByRole('button', { name: 'Add 2' }))

  // The teacher must be left where they can fix it, with the offending row identified.
  const message = await screen.findByText(/nothing was added/)
  expect(message.textContent).toContain('rows 1')
  expect(onClose).not.toHaveBeenCalled()
})

test('a refusal is not-yet — the teacher can fix it, so it is not a fault', async () => {
  server.use(cleanPreview(), bulkRefused())
  const { user } = open()

  await user.type(screen.getByLabelText('One name per line'), 'Chen W\nDara P')
  await user.click(screen.getByRole('button', { name: 'Check names' }))
  await user.click(await screen.findByRole('button', { name: 'Add 2' }))

  const message = await screen.findByText(/nothing was added/)
  expect(message.className).toContain('not-yet')
  expect(message.className).not.toContain('system-error')
})
