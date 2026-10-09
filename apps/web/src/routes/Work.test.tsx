/**
 * Persistence, the guard, and the autosave debounce.
 *
 * Monaco is mocked. It does not render usefully in jsdom, and what is under test here is
 * whether a child's work survives — not whether an editor edits. The mock is a plain
 * textarea honouring the same two props, which doubles as a standing check that the
 * `CodeSurface` boundary really is one.
 *
 * **Real timers throughout.** Fake timers deadlock against MSW: advancing the clock does
 * not let a mocked fetch resolve, so the debounce never fires and the test times out
 * rather than failing. Waiting two seconds for real is slower and tells the truth.
 */

import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router'
import { expect, test, vi } from 'vitest'
import { renderScreen } from '../test/render'
import {
  countSaves,
  createsDocument,
  noDocuments,
  renameRefused,
  savesRefused,
  server,
  signedOut,
} from '../test/server'

/**
 * `defaultValue`, not `value` — and that is the whole point of the mock.
 *
 * Monaco is **uncontrolled after mount**: `value` is the initial document and the editor
 * owns the text thereafter, which is what keeps typing off the network. A controlled
 * textarea would revert every keystroke, so a controlled mock would not be testing the
 * real contract. `Work` passes `key={activeId}`, so this remounts when the file changes.
 */
vi.mock('../editor/CodeSurface', () => ({
  CodeSurface: ({
    value,
    onChange,
  }: {
    value: string
    onChange: (next: string) => void
  }) => (
    <textarea
      aria-label="Your program"
      defaultValue={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))

// The Python runtime never boots in jsdom, and none of these tests run code.
vi.mock('../runtime/usePython', () => ({
  usePython: () => ({
    state: { status: 'idle' },
    output: [],
    run: vi.fn(),
    stop: vi.fn(),
    answer: vi.fn(),
  }),
}))

const { Work } = await import('./Work')
const { RequireStudent } = await import('./RequireStudent')

/** Long enough for the 2 s debounce plus a mocked round trip. */
const AFTER_AUTOSAVE = { timeout: 4_000 }

/** `findBy*` waits for the element, not its contents — so the value needs its own wait. */
async function editorWithValue(expected: string) {
  await waitFor(
    () => expect(screen.getByLabelText('Your program')).toHaveValue(expected),
    { timeout: 3_000 },
  )
  return screen.getByLabelText('Your program')
}

function renderGuarded() {
  return renderScreen(
    <Routes>
      <Route element={<RequireStudent />}>
        <Route path="/work" element={<Work />} />
      </Route>
      <Route path="/" element={<p>Student sign-in</p>} />
    </Routes>,
    { route: '/work' },
  )
}

// --- reopening -----------------------------------------------------------------------

test('it reopens the file they were last editing', async () => {
  // §3.1's promise in one assertion: the list comes back newest-edited first, so the
  // first tab is the one they left off in.
  renderScreen(<Work />, { route: '/work' })

  await editorWithValue('print("spiral")\n')
  expect(screen.getByRole('tab', { name: 'spiral' })).toHaveAttribute('aria-selected', 'true')
})

test('every file they have appears as a tab', async () => {
  renderScreen(<Work />, { route: '/work' })
  expect(await screen.findByRole('tab', { name: 'spiral' })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'squares' })).toBeInTheDocument()
})

test('switching tabs loads the other file', async () => {
  const { user } = renderScreen(<Work />, { route: '/work' })
  await editorWithValue('print("spiral")\n')

  await user.click(screen.getByRole('tab', { name: 'squares' }))

  await editorWithValue('print("squares")\n')
})

test('a brand-new student gets a file made for them', async () => {
  // Nothing to reopen, so the editor must not sit empty waiting to be told what to do.
  // The starter content comes from the server, which is the only place it is defined.
  server.use(noDocuments(), createsDocument())
  renderScreen(<Work />, { route: '/work' })

  await editorWithValue('# Write your Python here, then press Run.\nprint("Hello!")\n')
})

// --- autosave ------------------------------------------------------------------------

test('typing a burst produces one save, not one per keystroke', async () => {
  const { calls, handler } = countSaves()
  server.use(handler)
  const user = userEvent.setup()
  renderScreen(<Work />, { route: '/work' })

  const box = await editorWithValue('print("spiral")\n')
  await user.clear(box)
  await user.type(box, 'print(1)')

  await waitFor(() => expect(calls).toHaveLength(1), AFTER_AUTOSAVE)
  expect(calls[0]?.content).toBe('print(1)')
})

test('a quiet editor saves nothing', async () => {
  // Reading your own file back must not write it — otherwise `updated_at` moves and the
  // tabs reshuffle under someone who is only looking.
  const { calls, handler } = countSaves()
  server.use(handler)
  renderScreen(<Work />, { route: '/work' })
  await editorWithValue('print("spiral")\n')

  await new Promise((resolve) => setTimeout(resolve, 3_000))
  expect(calls).toHaveLength(0)
})

test('typing and undoing back to the original saves nothing', async () => {
  // The case the no-op guard actually exists for: a child types, thinks better of it, and
  // presses Ctrl-Z back to where they started. Writing that would move `updated_at` and
  // reshuffle the tabs for a change that was never made.
  const { calls, handler } = countSaves()
  server.use(handler)
  const user = userEvent.setup()
  renderScreen(<Work />, { route: '/work' })

  const box = await editorWithValue('print("spiral")\n')
  await user.type(box, 'x')
  await user.clear(box)
  await user.type(box, 'print("spiral")\n')

  await new Promise((resolve) => setTimeout(resolve, 3_000))
  expect(calls).toHaveLength(0)
})

test('a failed save is said out loud rather than hidden', async () => {
  // The one thing on this screen that is genuinely our fault, so the one thing allowed to
  // be system-error. A child typing into a page that silently discards their work is exactly the
  // failure worth shouting about.
  server.use(savesRefused())
  const user = userEvent.setup()
  renderScreen(<Work />, { route: '/work' })

  const box = await editorWithValue('print("spiral")\n')
  await user.type(box, 'x')

  const warning = await screen.findByText(/not saving/i, undefined, AFTER_AUTOSAVE)
  expect(warning.className).toContain('system-error')
})

// --- renaming ------------------------------------------------------------------------

test('renaming onto a name already in use says so', async () => {
  // Without this the tab just reverted and nothing explained why, which reads as the
  // rename having silently failed for no reason.
  server.use(renameRefused())
  const { user } = renderScreen(<Work />, { route: '/work' })
  await editorWithValue('print("spiral")\n')

  await user.dblClick(screen.getByRole('tab', { name: 'spiral' }))
  const box = screen.getByLabelText('Rename spiral')
  await user.clear(box)
  await user.type(box, 'squares{Enter}')

  const message = await screen.findByText(/already have a file with that name/i)
  // Amber: renaming to something else fixes it, so it is "not yet", not a fault.
  expect(message.className).toContain('not-yet')
  expect(message.className).not.toContain('system-error')
})

test('a rename that does not clash raises nothing', async () => {
  const { user } = renderScreen(<Work />, { route: '/work' })
  await editorWithValue('print("spiral")\n')

  await user.dblClick(screen.getByRole('tab', { name: 'spiral' }))
  const box = screen.getByLabelText('Rename spiral')
  await user.clear(box)
  await user.type(box, 'my spiral{Enter}')

  await waitFor(() =>
    expect(screen.queryByText(/already have a file/i)).not.toBeInTheDocument(),
  )
})

// --- the guard -----------------------------------------------------------------------

test('a signed-out visitor is sent to the sign-in, not shown an editor that cannot save', async () => {
  server.use(...signedOut())
  renderGuarded()

  expect(await screen.findByText('Student sign-in')).toBeInTheDocument()
  expect(screen.queryByLabelText('Your program')).not.toBeInTheDocument()
})

test('a signed-in student sees whose account they are in', async () => {
  // On a borrowed laptop this is the question that matters before you start typing.
  renderGuarded()

  expect(await screen.findByText('Aria K')).toBeInTheDocument()
  expect(screen.getByText(/Year 4-6 Python/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
})
