/**
 * The contract between the page and the Python worker.
 *
 * Kept in its own module so both sides import the same types, and so Phase 3's turtle
 * command stream can be added as another `FromWorker` variant rather than reopening the
 * design.
 *
 * **Two things deliberately do not travel as messages**: stdin answers and interrupts.
 * While the worker is blocked in `Atomics.wait` it does not process its message queue, so
 * anything needed *by* a blocked worker has to arrive through shared memory. See
 * `channel.ts`.
 */

/**
 * One test case, as the grader takes it — the API's test shape minus anything the
 * grader does not read. `expected` on a hidden test is still here: it has to be, to
 * compare against, which is the accepted cost of running tests in the browser.
 */
export type TestCheck =
  | {
      kind: 'io'
      name: string
      hidden?: boolean
      stdin?: string
      expected: string
      match?: 'exact' | 'contains'
    }
  | { kind: 'function'; name: string; hidden?: boolean; call: string; expected: string }

/** One test's outcome. A hidden test carries only `name`, `hidden` and `passed`. */
export interface TestResult {
  name: string
  hidden: boolean
  passed: boolean
  got?: string
  expected?: string
  error?: string | null
}

/**
 * One piece of a sample run (17 Oct 2026): what the program printed, or what was typed at
 * an `input()`. The same shape the API stores as an example's transcript.
 */
export interface ExamplePiece {
  kind: 'out' | 'in'
  text: string
}

export interface ExampleRun {
  transcript: ExamplePiece[]
  /** Why the run ended early — an error, or more `input()`s than inputs. */
  error: string | null
}

export interface TestRun {
  /** Set when the program does not parse — then nothing ran and every result fails. */
  compile_error: string | null
  results: TestResult[]
}

/** Sent from the page to the worker. */
export type ToWorker =
  | { type: 'init'; indexURL: string; interrupt: Uint8Array; stdin: SharedArrayBuffer }
  | { type: 'run'; runId: number; code: string }
  /** Grade `code` against `tests` in fresh globals; the child's session is untouched. */
  | { type: 'check'; runId: number; code: string; tests: TestCheck[] }
  /** Run `code` once, typing `inputs` at its `input()`s, and record the conversation. */
  | { type: 'example'; runId: number; code: string; inputs: string[] }

/** Sent from the worker to the page. */
export type FromWorker =
  /** Pyodide is downloading or starting. `detail` is for the loading line, not for logs. */
  | { type: 'loading'; detail: string }
  /** Ready to accept `run`. Sent once per worker. */
  | { type: 'ready'; version: string }
  /**
   * Exact bytes Python wrote, newlines and all. **Not line-oriented**: `print("a", end="")`
   * produces a chunk with no newline, and `input("Name? ")` writes its prompt the same way,
   * which is what leaves the cursor sitting after the question like a real terminal.
   */
  | { type: 'stdout'; runId: number; text: string }
  | { type: 'stderr'; runId: number; text: string }
  /** The program called `input()`. The page must answer through the stdin channel. */
  | { type: 'stdin'; runId: number }
  /** The program printed more than the worker is willing to forward. */
  | { type: 'truncated'; runId: number }
  | { type: 'done'; runId: number; ok: boolean; interrupted: boolean }
  /** A `check` finished. `run` is null when it was stopped before finishing. */
  | { type: 'checked'; runId: number; run: TestRun | null }
  /** An `example` finished. `run` is null when it was stopped before finishing. */
  | { type: 'exampled'; runId: number; run: ExampleRun | null }
  /** The worker itself failed — Pyodide could not load. Ours to fix, not the student's. */
  | { type: 'fatal'; message: string }

/**
 * How much output the console keeps, in characters.
 *
 * The **newest** output is kept and the oldest dropped, which is what a terminal's
 * scrollback does. It matters for the common accident: a child writes
 * `for i in range(5000): print(i)` and wants to see it reach 4999. Keeping the first 2,000
 * lines instead would show them 0..1999 and no ending, which is the half of the output they
 * did not print it for.
 */
export const MAX_OUTPUT_CHARS = 200_000

/**
 * A backstop against a pathological program, well above anything a lesson produces.
 *
 * The page drops old output anyway, so this only exists to stop the worker shipping
 * megabytes across a postMessage boundary that will be thrown away on arrival.
 */
export const MAX_FORWARDED_CHARS = 5_000_000

/** stdout is batched rather than posted per write, or `print` in a loop floods the page. */
export const FLUSH_INTERVAL_MS = 50
