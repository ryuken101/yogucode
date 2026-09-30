/**
 * Pressing Run on a cold page.
 *
 * The bug this exists for: the hook posted `init` and `run` back to back, the worker
 * re-entered `onmessage` while `init` was still awaiting the Pyodide download, and the
 * queued `run` landed with no interpreter. A child pressed Run, was told Python was
 * starting, and had to press it again. **The first interaction with the product was
 * broken.**
 *
 * The real `Worker` is replaced with a stub that performs the same handshake — `loading`,
 * then `ready` after a tick — because what is under test is the hook's sequencing, not
 * Pyodide.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { FromWorker, ToWorker } from './protocol'

/** Messages the hook sent, so the test can prove a run was posted exactly once. */
let posted: ToWorker[] = []
/** Held so the test controls when boot finishes. */
let finishBoot: (() => void) | null = null

class StubWorker {
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null
  onerror: (() => void) | null = null
  terminate = vi.fn()

  postMessage(message: ToWorker) {
    posted.push(message)
    if (message.type !== 'init') return

    this.emit({ type: 'loading', detail: 'Downloading Python' })
    // Boot completes only when the test says so, which is what makes the race reproducible.
    finishBoot = () => {
      this.emit({ type: 'ready', version: '314.0.7' })
      // The worker dispatches whatever it queued during boot; mirrored here by echoing a
      // `done` for the run it would have executed.
      const queued = posted.find((m) => m.type === 'run')
      if (queued && queued.type === 'run') {
        this.emit({ type: 'stdout', runId: queued.runId, text: 'hello\n' })
        this.emit({ type: 'done', runId: queued.runId, ok: true, interrupted: false })
      }
    }
  }

  private emit(message: FromWorker) {
    act(() => this.onmessage?.({ data: message } as MessageEvent<FromWorker>))
  }
}

beforeEach(() => {
  posted = []
  finishBoot = null
  vi.stubGlobal('Worker', StubWorker)
  // The hook refuses to run at all without cross-origin isolation, and rightly so.
  vi.stubGlobal('crossOriginIsolated', true)
  vi.stubGlobal('SharedArrayBuffer', ArrayBuffer)
})

afterEach(() => vi.unstubAllGlobals())

const { usePython } = await import('./usePython')

test('one press of Run is enough on a cold page', async () => {
  const { result } = renderHook(() => usePython())
  expect(result.current.state.status).toBe('idle')

  act(() => result.current.run('print("hello")'))

  // The run is already on the wire — the worker holds it rather than rejecting it.
  expect(posted.filter((m) => m.type === 'run')).toHaveLength(1)
  // And the child is told what is happening rather than seeing a dead Run button.
  expect(result.current.state.status).toBe('loading')

  act(() => finishBoot?.())

  await waitFor(() => expect(result.current.state.status).toBe('idle'))
  expect(result.current.output.map((line) => line.text)).toContain('hello\n')
  // Crucially: still one run. A second press would have been the old workaround.
  expect(posted.filter((m) => m.type === 'run')).toHaveLength(1)
})

test('the worker is only created when someone actually runs something', () => {
  // 5.7 MB should be fetched because a child pressed Run, not because a page opened.
  renderHook(() => usePython())
  expect(posted).toHaveLength(0)
})

test('a second run after boot goes straight to running', async () => {
  const { result } = renderHook(() => usePython())
  act(() => result.current.run('print("hello")'))
  act(() => finishBoot?.())
  await waitFor(() => expect(result.current.state.status).toBe('idle'))

  act(() => result.current.run('print("again")'))
  expect(result.current.state.status).toBe('running')
})

test('without cross-origin isolation it refuses rather than hanging', () => {
  // A program would otherwise block forever on the first input() with no explanation.
  vi.stubGlobal('crossOriginIsolated', false)
  const { result } = renderHook(() => usePython())

  expect(result.current.state.status).toBe('unsupported')
  act(() => result.current.run('print("hello")'))
  expect(posted).toHaveLength(0)
})
