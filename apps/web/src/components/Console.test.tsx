/**
 * The terminal.
 *
 * Two things are tested here that are easy to get wrong and expensive to get wrong:
 *
 * 1. **The palette rule.** Every tool a programmer has used prints errors in red. This one
 *    shows them to nine-year-olds, so a traceback is `not-yet` (lemon) and `system-error`
 *    is reserved for our own failures. A test, because reflex beats a comment.
 * 2. **Input happens in the terminal.** Typing goes where the cursor is, not into a field
 *    below, and what the child typed is echoed into the transcript.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { Console } from './Console'

test('ordinary output is the plain text colour, not an alarming one', () => {
  // Cream rather than ink, because the terminal is a dark surface — the palette is the
  // same eleven colours, just the other way up.
  render(<Console segments={[{ stream: 'stdout', text: 'Hello!' }]} />)
  const line = screen.getByText('Hello!')
  expect(line.className).toContain('text-cream')
  expect(line.className).not.toContain('not-yet')
  expect(line.className).not.toContain('system-error')
})

test('a traceback is not-yet and never system-error', () => {
  render(<Console segments={[{ stream: 'stderr', text: 'NameError: x is not defined' }]} />)
  const line = screen.getByText(/NameError/)
  expect(line.className).toContain('not-yet')
  expect(line.className).not.toContain('system-error')
})

test('nothing a student can cause renders system-error', () => {
  render(
    <Console
      segments={[
        { stream: 'stdout', text: 'ok\n' },
        { stream: 'stderr', text: 'SyntaxError: invalid syntax\n' },
        { stream: 'stdin', text: 'Aria\n' },
        { stream: 'system', text: '── earlier output dropped ──\n' },
      ]}
    />,
  )
  expect(document.body.innerHTML).not.toContain('system-error')
})

test('an empty terminal explains itself rather than sitting blank', () => {
  render(<Console segments={[]} />)
  expect(screen.getByText(/Press Run/)).toBeInTheDocument()
})

test('output is announced without stealing focus', () => {
  render(<Console segments={[{ stream: 'stdout', text: 'Hello!' }]} />)
  expect(screen.getByRole('log', { name: 'Program output' })).toHaveAttribute(
    'aria-live',
    'polite',
  )
})

test('partial writes join on one line, so a prompt keeps the cursor beside it', () => {
  // `input("Name? ")` writes without a newline. If output were line-oriented the prompt
  // would sit on its own line and the caret would appear underneath it.
  const { container } = render(
    <Console segments={[{ stream: 'stdout', text: 'What is your name? ' }]} asking />,
  )
  const flow = container.querySelector('.whitespace-pre-wrap')
  expect(flow?.textContent).toContain('What is your name? ')
  // The caret is inside the same flow as the prompt, not in a separate block below it.
  expect(flow?.querySelector('input')).not.toBeNull()
})

test('the child types in the terminal, and the answer is reported', async () => {
  const onAnswer = vi.fn()
  const user = userEvent.setup()
  render(
    <Console
      segments={[{ stream: 'stdout', text: 'What is your name? ' }]}
      asking
      onAnswer={onAnswer}
    />,
  )

  await user.type(screen.getByLabelText('Your answer'), 'Aria{Enter}')
  expect(onAnswer).toHaveBeenCalledWith('Aria')
})

test('the terminal takes focus when a program asks, without being clicked', () => {
  render(<Console segments={[{ stream: 'stdout', text: 'Name? ' }]} asking onAnswer={vi.fn()} />)
  expect(screen.getByLabelText('Your answer')).toHaveFocus()
})

test('there is nowhere to type when the program is not asking', () => {
  render(<Console segments={[{ stream: 'stdout', text: 'done\n' }]} />)
  expect(screen.queryByLabelText('Your answer')).not.toBeInTheDocument()
})

test('whitespace is preserved, because Python indentation is meaningful', () => {
  const { container } = render(<Console segments={[{ stream: 'stdout', text: '  indented' }]} />)
  expect(container.querySelector('.whitespace-pre-wrap')).not.toBeNull()
})
