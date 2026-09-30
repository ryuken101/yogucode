// @vitest-environment node
// Node types are referenced here rather than added to tsconfig.app.json's `types`,
// which would let application code reach for `process` and friends by accident.
/// <reference types="node" />
/**
 * The shared-memory channel, across two real threads.
 *
 * `Atomics.wait` **blocks the thread it runs on**, so this cannot be tested on one thread:
 * the waiter would block the very code meant to wake it. That is not a quirk of the test —
 * it is the entire reason the runtime puts Python in a Worker. A single-threaded attempt at
 * this deadlocks, which is exactly what happened when I first tried to verify the interrupt
 * in a plain Node script.
 *
 * Runs in the `node` environment (see the filename suffix and vite.config.ts) because jsdom
 * has no worker_threads and browsers forbid `Atomics.wait` on the main thread.
 *
 * Pyodide is deliberately absent: what is under test is *our* protocol, not Pyodide's
 * interrupt handling. That gets verified by hand in a browser, where it actually ships.
 */

import { Worker } from 'node:worker_threads'
import { expect, test } from 'vitest'
import {
  STDIN_ANSWERED,
  STDIN_INTERRUPTED,
  STDIN_WAITING,
  answerStdin,
  cancelStdin,
  clearInterrupt,
  createInterruptBuffer,
  createStdinBuffer,
  isWaitingForStdin,
  signalInterrupt,
} from './channel'

/**
 * A stand-in for the Python worker: it parks on the stdin channel exactly as
 * `awaitStdin` does, then reports what it received.
 *
 * `awaitStdin` itself is re-implemented here rather than imported, because a Node worker
 * cannot import a TypeScript module without a loader. The layout it assumes is asserted
 * against the real constants below, so the two cannot drift apart silently.
 */
const WORKER_SOURCE = `
  const { parentPort, workerData } = require('node:worker_threads')
  const { buffer, waiting, answered } = workerData
  const header = new Int32Array(buffer, 0, 2)
  const text = new Uint8Array(buffer, 8, buffer.byteLength - 8)

  Atomics.store(header, 0, waiting)
  Atomics.store(header, 1, 0)
  parentPort.postMessage({ parked: true })

  Atomics.wait(header, 0, waiting, 5000)

  const state = Atomics.load(header, 0)
  const length = Atomics.load(header, 1)
  parentPort.postMessage({
    state,
    answer: state === answered ? new TextDecoder().decode(text.slice(0, length)) : null,
  })
`

function parkedWorker(buffer: SharedArrayBuffer) {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { buffer, waiting: STDIN_WAITING, answered: STDIN_ANSWERED },
  })
  const parked = new Promise<void>((resolve) => {
    worker.once('message', () => resolve())
  })
  const result = new Promise<{ state: number; answer: string | null }>((resolve) => {
    worker.on('message', (message: { parked?: true; state: number; answer: string | null }) => {
      if (!('parked' in message)) resolve(message)
    })
  })
  return { worker, parked, result }
}

test('this file really is running outside jsdom', () => {
  // If environmentMatchGlobs stops being honoured, these tests would quietly run under
  // jsdom — where they might still pass, since jsdom runs on Node and can reach
  // worker_threads. That would make the suite lie about what it covers, so the
  // environment is asserted rather than assumed.
  expect(typeof document).toBe('undefined')
  expect(typeof window).toBe('undefined')
})

test('an answer typed on the page reaches a parked worker', async () => {
  const buffer = createStdinBuffer()
  const { worker, parked, result } = parkedWorker(buffer)
  await parked

  // The page can see that a program is waiting, which is what drives the prompt UI.
  expect(isWaitingForStdin(buffer)).toBe(true)

  answerStdin(buffer, 'Aria')
  await expect(result).resolves.toEqual({ state: STDIN_ANSWERED, answer: 'Aria' })
  expect(isWaitingForStdin(buffer)).toBe(false)
  await worker.terminate()
})

test('Stop while waiting for input unblocks the worker with a cancel, not an answer', async () => {
  // The case the interrupt buffer cannot cover: Python is not executing, so Pyodide never
  // looks at it. Getting this wrong is a Stop button that does nothing.
  const buffer = createStdinBuffer()
  const { worker, parked, result } = parkedWorker(buffer)
  await parked

  cancelStdin(buffer)
  await expect(result).resolves.toEqual({ state: STDIN_INTERRUPTED, answer: null })
  await worker.terminate()
})

test('an answer with non-ASCII characters survives the round trip', async () => {
  const buffer = createStdinBuffer()
  const { worker, parked, result } = parkedWorker(buffer)
  await parked

  answerStdin(buffer, 'Zoë 🙂')
  await expect(result).resolves.toMatchObject({ answer: 'Zoë 🙂' })
  await worker.terminate()
})

test('an answer longer than the buffer is truncated rather than corrupting memory', async () => {
  const buffer = createStdinBuffer()
  const { worker, parked, result } = parkedWorker(buffer)
  await parked

  answerStdin(buffer, 'x'.repeat(20_000))
  const { answer } = await result
  expect(answer).not.toBeNull()
  expect(answer!.length).toBeLessThanOrEqual(8 * 1024)
  await worker.terminate()
})

test('the page is not waiting when nothing is parked', () => {
  expect(isWaitingForStdin(createStdinBuffer())).toBe(false)
})

test('the interrupt buffer carries SIGINT and can be cleared', () => {
  // Pyodide reads this byte itself; 2 is SIGINT. The value matters, so it is asserted.
  const buffer = createInterruptBuffer()
  expect(buffer[0]).toBe(0)
  signalInterrupt(buffer)
  expect(buffer[0]).toBe(2)
  clearInterrupt(buffer)
  expect(buffer[0]).toBe(0)
})

test('both channels are shared memory, or neither would reach a blocked worker', () => {
  expect(createInterruptBuffer().buffer).toBeInstanceOf(SharedArrayBuffer)
  expect(createStdinBuffer()).toBeInstanceOf(SharedArrayBuffer)
})
