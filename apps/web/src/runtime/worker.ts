/// <reference lib="webworker" />
/**
 * Python, in a Web Worker.
 *
 * A worker rather than the page, per product-spec §5.1, for one blunt reason: a Year 4-6
 * student writing their first `while` loop will write one that never ends. On the main
 * thread that freezes the tab and the child loses their work. Here it occupies a worker
 * that can be interrupted — or in the worst case discarded — while the page stays alive.
 *
 * Pyodide is loaded from our own origin (`/pyodide/`), copied there from node_modules by
 * `scripts/copy-pyodide.mjs`. Same-origin satisfies `require-corp`, which the page needs
 * set anyway for `SharedArrayBuffer`.
 *
 * The interpreter is created **once** and reused across runs. That is what makes Stop worth
 * having: a child stops a runaway loop and their variables are still there, rather than
 * waiting several seconds for a fresh interpreter.
 */

import {
  FLUSH_INTERVAL_MS,
  MAX_FORWARDED_CHARS,
  type ExampleRun,
  type FromWorker,
  type TestRun,
  type ToWorker,
} from './protocol'
import { awaitStdin, clearInterrupt } from './channel'
import graderSource from './grader.py?raw'

// Pyodide's own types describe far more than this worker touches, and importing them would
// pull the package into the bundle — the whole point is that it is fetched at runtime.
interface Pyodide {
  version: string
  FS: { writeFile(path: string, data: string): void }
  runPython(code: string): unknown
  runPythonAsync(code: string): Promise<unknown>
  pyimport(name: string): {
    run_tests(code: string, tests: string): string
    run_example(code: string, inputs: string): string
  }
  setStdout(options: { write: (buffer: Uint8Array) => number }): void
  setStderr(options: { write: (buffer: Uint8Array) => number }): void
  setStdin(options: { stdin: () => string | null; autoEOF?: boolean }): void
  setInterruptBuffer(buffer: Uint8Array): void
}

let pyodide: Pyodide | null = null
let interruptBuffer: Uint8Array | null = null
let stdinBuffer: SharedArrayBuffer | null = null

function post(message: FromWorker): void {
  self.postMessage(message)
}

/* --- output ------------------------------------------------------------------------
 *
 * The **raw** `write` handler rather than `batched`, because a terminal is byte-accurate
 * and `batched` is line-oriented: it strips newlines and hands over whole lines, so
 * `print("a", end="")` and `input("Name? ")` — both of which write without a newline —
 * come out on lines of their own. Getting that wrong is what put the input prompt above
 * the cursor instead of in front of it.
 *
 * Writes accumulate and flush on a timer, so `print` in a loop cannot post a message per
 * iteration and take the page down with it.
 */

interface Sink {
  flush(): void
  write(stream: 'stdout' | 'stderr', text: string): void
  reset(): void
}

function createSink(getRunId: () => number): Sink {
  let pending: { stream: 'stdout' | 'stderr'; text: string }[] = []
  let forwarded = 0
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (pending.length === 0) return
    const runId = getRunId()
    // Adjacent writes to the same stream coalesce, but the streams stay in order relative
    // to each other — interleaving them would put a traceback in the wrong place.
    const batched = pending
    pending = []
    let run: { stream: 'stdout' | 'stderr'; text: string } | null = null
    for (const entry of batched) {
      if (run && run.stream === entry.stream) {
        run.text += entry.text
        continue
      }
      if (run) post({ type: run.stream, runId, text: run.text })
      run = { ...entry }
    }
    if (run) post({ type: run.stream, runId, text: run.text })
  }

  return {
    flush,
    reset() {
      pending = []
      forwarded = 0
      stopped = false
    },
    write(stream, text) {
      if (stopped) return
      forwarded += text.length
      if (forwarded > MAX_FORWARDED_CHARS) {
        stopped = true
        flush()
        post({ type: 'truncated', runId: getRunId() })
        return
      }
      pending.push({ stream, text })
      timer ??= setTimeout(flush, FLUSH_INTERVAL_MS)
    },
  }
}

let currentRunId = 0
/** Set when a prompt ended without an answer (Stop, or nobody answered). */
let stoppedAtPrompt = false
const sink = createSink(() => currentRunId)

type Job = Extract<ToWorker, { type: 'run' | 'check' | 'example' }>

/** A run or check that arrived while Pyodide was still loading; dispatched once ready. */
let queuedJob: Job | null = null

let grader: ReturnType<Pyodide['pyimport']> | null = null

/* --- boot --------------------------------------------------------------------------- */

async function init(message: Extract<ToWorker, { type: 'init' }>): Promise<void> {
  interruptBuffer = message.interrupt
  stdinBuffer = message.stdin

  post({ type: 'loading', detail: 'Downloading Python' })
  // A bare specifier would be resolved and bundled by Vite; this is a runtime fetch of a
  // file that is copied into public/ rather than compiled in.
  const module = await import(/* @vite-ignore */ `${message.indexURL}pyodide.mjs`)

  post({ type: 'loading', detail: 'Starting Python' })
  pyodide = (await module.loadPyodide({ indexURL: message.indexURL })) as Pyodide

  const decoder = new TextDecoder()
  // `write` must return how many bytes it consumed, or Emscripten retries forever.
  pyodide.setStdout({
    write: (buffer) => {
      sink.write('stdout', decoder.decode(buffer, { stream: true }))
      return buffer.byteLength
    },
  })
  pyodide.setStderr({
    write: (buffer) => {
      sink.write('stderr', decoder.decode(buffer, { stream: true }))
      return buffer.byteLength
    },
  })
  pyodide.setInterruptBuffer(interruptBuffer)

  /**
   * The synchronous stdin callback — the reason the page has to be cross-origin isolated.
   *
   * Returning `null` signals EOF to Pyodide, which raises `EOFError` in Python, so the run
   * unwinds normally rather than the worker being killed. `stoppedAtPrompt` remembers why,
   * so `run` reports it as a stop, not as the child's error: before 23 Oct 2026 Stop at a
   * prompt showed an EOFError traceback with Pyodide's own file paths in it.
   */
  pyodide.setStdin({
    stdin: () => {
      if (!stdinBuffer) return null
      // Flush first, or the prompt text printed by `input("...")` arrives after the
      // question has already been asked.
      sink.flush()
      post({ type: 'stdin', runId: currentRunId })
      const answer = awaitStdin(stdinBuffer)
      if (answer === null) stoppedAtPrompt = true
      return answer
    },
  })

  // The grader is a module of its own, so its names never appear in the child's session
  // and a child's variable called `run_tests` cannot shadow it.
  pyodide.FS.writeFile('/home/pyodide/_grader.py', graderSource)
  pyodide.runPython('import sys\nif "/home/pyodide" not in sys.path: sys.path.insert(0, "/home/pyodide")')
  grader = pyodide.pyimport('_grader')

  post({ type: 'ready', version: pyodide.version })

  // Whoever pressed Run before Python finished loading gets their run now, rather than
  // having to press it a second time.
  if (queuedJob) {
    const waiting = queuedJob
    queuedJob = null
    await dispatch(waiting)
  }
}

async function dispatch(job: Job): Promise<void> {
  if (job.type === 'run') await run(job)
  else if (job.type === 'check') await check(job)
  else await example(job)
}

/* --- run ---------------------------------------------------------------------------- */

async function run(message: Extract<ToWorker, { type: 'run' }>): Promise<void> {
  if (!pyodide || !interruptBuffer) {
    // A run can arrive mid-boot: `onmessage` is re-entered while `init` is still awaiting
    // the Pyodide download, so the queued `run` lands with no interpreter. That is not a
    // failure — it is a child pressing Run on a cold page, which is the *normal* first
    // interaction. Hold it and let `init` dispatch it.
    queuedJob = message
    return
  }
  currentRunId = message.runId
  stoppedAtPrompt = false
  sink.reset()
  // A Stop pressed before this run started must not kill it.
  clearInterrupt(interruptBuffer)

  let ok = true
  let interrupted = false
  try {
    await pyodide.runPythonAsync(message.code)
  } catch (error) {
    ok = false
    const text = error instanceof Error ? error.message : String(error)
    interrupted = text.includes('KeyboardInterrupt') || (stoppedAtPrompt && text.includes('EOFError'))
    // Python's own traceback, which the console shows as not-yet: this is the student's
    // mistake, not a failure of ours. A stop is neither, and the page says so itself.
    if (!interrupted) sink.write('stderr', `${text.trimEnd()}\n`)
  } finally {
    sink.flush()
    clearInterrupt(interruptBuffer)
    post({ type: 'done', runId: message.runId, ok, interrupted })
  }
}

/* --- check ------------------------------------------------------------------------- */

/**
 * Grade a program against test cases. See `grader.py` for what "fresh globals" and the
 * per-test deadline mean.
 *
 * Synchronous inside Python, so the worker is busy for the whole check — which is fine,
 * because the editor does not offer Run while a check is going. Stop still works: the
 * interrupt buffer raises KeyboardInterrupt, which the grader lets through, and the page
 * gets `run: null`.
 */
async function check(message: Extract<ToWorker, { type: 'check' }>): Promise<void> {
  if (!pyodide || !interruptBuffer || !grader) {
    queuedJob = message
    return
  }
  clearInterrupt(interruptBuffer)
  let result: TestRun | null = null
  try {
    result = JSON.parse(grader.run_tests(message.code, JSON.stringify(message.tests))) as TestRun
  } catch {
    result = null
  } finally {
    clearInterrupt(interruptBuffer)
    post({ type: 'checked', runId: message.runId, run: result })
  }
}

/** A sample run for a problem's example (`grader.run_example`), synchronous like a check. */
async function example(message: Extract<ToWorker, { type: 'example' }>): Promise<void> {
  if (!pyodide || !interruptBuffer || !grader) {
    queuedJob = message
    return
  }
  clearInterrupt(interruptBuffer)
  let result: ExampleRun | null = null
  try {
    result = JSON.parse(
      grader.run_example(message.code, JSON.stringify(message.inputs)),
    ) as ExampleRun
  } catch {
    result = null
  } finally {
    clearInterrupt(interruptBuffer)
    post({ type: 'exampled', runId: message.runId, run: result })
  }
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data
  try {
    if (message.type === 'init') await init(message)
    if (message.type === 'run' || message.type === 'check' || message.type === 'example') {
      await dispatch(message)
    }
  } catch (error) {
    post({
      type: 'fatal',
      message: error instanceof Error ? error.message : 'Python failed to start.',
    })
  }
}
