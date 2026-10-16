/**
 * How the program should run (17 Oct 2026): a sample run that plays as if typed, can be
 * replayed, and is all there at once when reduced motion is asked for.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ExampleRun } from './ExampleRun'

const run = [
  { kind: 'out' as const, text: 'Name? ' },
  { kind: 'in' as const, text: 'Ken' },
  { kind: 'out' as const, text: 'Hi Ken\n' },
]

function motion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduce, media: query }))
}

/** Time passing, a little at a time, so each step's render schedules the next. */
async function wait(ms: number) {
  for (let left = ms; left > 0; left -= 10) await act(() => vi.advanceTimersByTimeAsync(10))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('with reduced motion, the whole run is there at once', () => {
  motion(true)
  render(<ExampleRun examples={[run]} />)
  expect(screen.getByLabelText('Example run')).toHaveTextContent('Name? Ken Hi Ken')
})

test('it plays a line, then types the input, then prints the answer — and replays', async () => {
  motion(false)
  vi.useFakeTimers()
  render(<ExampleRun examples={[run]} />)
  const terminal = screen.getByLabelText('Example run')
  expect(terminal).not.toHaveTextContent('Name?')

  await wait(300)
  expect(terminal).toHaveTextContent('Name?')
  expect(terminal).not.toHaveTextContent('Ken')
  await wait(230)
  expect(terminal).toHaveTextContent('Name? Ke')
  await wait(2000)
  expect(terminal).toHaveTextContent('Name? Ken Hi Ken')

  fireEvent.click(screen.getByRole('button', { name: 'Replay' }))
  expect(terminal).not.toHaveTextContent('Hi Ken')
})

test('several examples are tabs; nothing to show is nothing', () => {
  motion(true)
  const other = [{ kind: 'out' as const, text: 'Bye\n' }]
  const { rerender } = render(<ExampleRun examples={[run, other]} />)
  expect(screen.getByRole('tab', { name: 'Example 1' })).toHaveAttribute('aria-selected', 'true')
  rerender(<ExampleRun examples={[]} />)
  expect(screen.queryByLabelText('Example run')).not.toBeInTheDocument()
})
