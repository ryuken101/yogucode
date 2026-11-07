import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import type { OutputSegment, RunState } from '../runtime/usePython'
import { RunAnswer } from './RunAnswer'

const python = vi.hoisted(() => ({
  run: vi.fn(),
  stop: vi.fn(),
  answer: vi.fn(),
  state: { status: 'idle' } as RunState,
  output: [] as OutputSegment[],
}))
vi.mock('../runtime/usePython', () => ({ usePython: () => python }))

beforeEach(() => {
  python.run.mockClear()
  python.stop.mockClear()
  python.state = { status: 'idle' }
  python.output = []
})

test('runs the code shown, in fresh globals, so the last child’s variables can’t help', async () => {
  render(<RunAnswer code="print(score)" owner="q:aria" />)
  await userEvent.click(screen.getByRole('button', { name: 'Run' }))
  expect(python.run).toHaveBeenCalledWith('print(score)', { fresh: true })
})

test('the next child never sees the last one’s output, and their program is stopped', async () => {
  python.output = [{ stream: 'stdout', text: 'ARIA OUTPUT' }]
  const { rerender } = render(<RunAnswer code="print(1)" owner="q:aria" />)
  await userEvent.click(screen.getByRole('button', { name: 'Run' }))
  expect(screen.getByText('ARIA OUTPUT')).toBeInTheDocument()

  python.state = { status: 'running' }
  rerender(<RunAnswer code="print(1)" owner="q:aria" />)
  python.stop.mockClear()
  rerender(<RunAnswer code="print(2)" owner="q:bella" />)
  expect(python.stop).toHaveBeenCalledOnce()
  expect(screen.queryByText('ARIA OUTPUT')).not.toBeInTheDocument()

  // Coming back to the child doesn't bring it up as new either, but it is theirs.
  rerender(<RunAnswer code="print(1)" owner="q:aria" />)
  expect(screen.getByText('ARIA OUTPUT')).toBeInTheDocument()
})

test('while a program runs: Stop works, Run waits', async () => {
  python.state = { status: 'running' }
  render(<RunAnswer code="while True: pass" owner="q:aria" />)
  expect(screen.getByRole('button', { name: 'Running…' })).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
  expect(python.stop).toHaveBeenCalled()
})

test('moving on with nothing running stops nothing', () => {
  const { rerender } = render(<RunAnswer code="print(1)" owner="q:aria" />)
  rerender(<RunAnswer code="print(2)" owner="q:bella" />)
  expect(python.stop).not.toHaveBeenCalled()
})
