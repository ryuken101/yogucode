/**
 * Shared memory between the page and the worker.
 *
 * Pyodide's stdin callback is **synchronous**: the interpreter blocks inside it waiting for
 * a string. A Worker has no synchronous way to ask the main thread for anything — except
 * `Atomics.wait()` on a `SharedArrayBuffer`, which is why this file exists and why the app
 * requires cross-origin isolation.
 *
 * The same constraint applies to stopping a program. `postMessage` cannot reach a blocked
 * worker, so both channels are shared memory.
 */

/** Cross-origin isolation is what makes SharedArrayBuffer available. */
export function isolated(): boolean {
  return typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated === true
}

/* --- the interrupt channel ----------------------------------------------------------
 *
 * One byte, read by Pyodide itself while executing Python. Writing 2 is SIGINT, which
 * surfaces as KeyboardInterrupt. It only works *while Python is running* — a program
 * blocked on input() is not executing, so this cannot rescue it. That case goes through
 * the stdin channel's INTERRUPTED state instead.
 */

export function createInterruptBuffer(): Uint8Array {
  return new Uint8Array(new SharedArrayBuffer(1))
}

export function signalInterrupt(buffer: Uint8Array): void {
  buffer[0] = 2
}

export function clearInterrupt(buffer: Uint8Array): void {
  buffer[0] = 0
}

/* --- the stdin channel --------------------------------------------------------------
 *
 * Layout: an Int32Array header followed by a byte region for the answer.
 *
 *   [0] state — WAITING while the worker is parked, then ANSWERED or INTERRUPTED
 *   [1] byteLength of the answer
 *   [8..] UTF-8 bytes of the answer
 */

const HEADER_INTS = 2
const HEADER_BYTES = HEADER_INTS * 4
/** A typed answer from a child, not a paste buffer. 8 KB is already absurdly generous. */
const TEXT_BYTES = 8 * 1024

export const STDIN_IDLE = 0
export const STDIN_WAITING = 1
export const STDIN_ANSWERED = 2
export const STDIN_INTERRUPTED = 3

/**
 * How long the worker will park before giving up.
 *
 * Without a bound, a page that closed or crashed while a program waited for input would
 * leave the worker blocked forever, holding its Pyodide instance. Ten minutes is far longer
 * than any child will sit at a prompt and short enough that nothing leaks for a lesson.
 */
const WAIT_TIMEOUT_MS = 10 * 60 * 1000

export function createStdinBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_BYTES + TEXT_BYTES)
}

interface Views {
  header: Int32Array
  text: Uint8Array
}

function views(buffer: SharedArrayBuffer): Views {
  return {
    header: new Int32Array(buffer, 0, HEADER_INTS),
    text: new Uint8Array(buffer, HEADER_BYTES, TEXT_BYTES),
  }
}

/* --- worker side ------------------------------------------------------------------- */

/**
 * Park the worker until the page answers, and return what it said.
 *
 * `null` means the run should end: either the child pressed Stop, or nobody answered.
 * The worker hands Python an EOF, so it unwinds normally rather than the worker being
 * killed, and reports the run as stopped rather than as the child's error.
 */
export function awaitStdin(buffer: SharedArrayBuffer): string | null {
  const { header, text } = views(buffer)
  Atomics.store(header, 0, STDIN_WAITING)
  Atomics.store(header, 1, 0)

  // The blocking call this whole apparatus exists for.
  Atomics.wait(header, 0, STDIN_WAITING, WAIT_TIMEOUT_MS)

  const state = Atomics.load(header, 0)
  Atomics.store(header, 0, STDIN_IDLE)
  if (state !== STDIN_ANSWERED) return null

  const length = Atomics.load(header, 1)
  return new TextDecoder().decode(text.slice(0, length))
}

/* --- page side --------------------------------------------------------------------- */

/** Hand the worker the child's answer and wake it. */
export function answerStdin(buffer: SharedArrayBuffer, answer: string): void {
  const { header, text } = views(buffer)
  // Python's input() strips the newline, so the answer is stored without one.
  const encoded = new TextEncoder().encode(answer)
  const length = Math.min(encoded.byteLength, text.byteLength)
  text.set(encoded.subarray(0, length))
  Atomics.store(header, 1, length)
  Atomics.store(header, 0, STDIN_ANSWERED)
  Atomics.notify(header, 0)
}

/** Wake a worker that is waiting for input, telling it to give up instead. */
export function cancelStdin(buffer: SharedArrayBuffer): void {
  const { header } = views(buffer)
  Atomics.store(header, 0, STDIN_INTERRUPTED)
  Atomics.notify(header, 0)
}

/** Whether a program is currently parked at an input() prompt. */
export function isWaitingForStdin(buffer: SharedArrayBuffer): boolean {
  return Atomics.load(views(buffer).header, 0) === STDIN_WAITING
}
