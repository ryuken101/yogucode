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
  type FromWorker,
  type ToWorker,
} from './protocol'
import { awaitStdin, clearInterrupt } from './channel'

// Pyodide's own types describe far more than this worker touches, and importing them would
// pull the package into the bundle — the whole point is that it is fetched at runtime.
interface Pyodide {
  version: string
  runPythonAsync(code: string): Promise<unknown>
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
const sink = createSink(() => currentRunId)

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
   * Returning `null` signals EOF to Pyodide, which raises `EOFError` in Python. That is
   * what a cancelled prompt should do: the run ends with a Python-level error the console
   * can show, rather than the worker being killed and the session lost.
   */
  pyodide.setStdin({
    stdin: () => {
      if (!stdinBuffer) return null
      // Flush first, or the prompt text printed by `input("...")` arrives after the
      // question has already been asked.
      sink.flush()
      post({ type: 'stdin', runId: currentRunId })
      return awaitStdin(stdinBuffer)
    },
  })

  post({ type: 'ready', version: pyodide.version })
}

/* --- run ---------------------------------------------------------------------------- */

async function run(message: Extract<ToWorker, { type: 'run' }>): Promise<void> {
  if (!pyodide || !interruptBuffer) {
    post({ type: 'fatal', message: 'Python is not ready yet.' })
    return
  }
  currentRunId = message.runId
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
    interrupted = text.includes('KeyboardInterrupt')
    // Python's own traceback, which the console shows in amber: this is the student's
    // mistake, not a failure of ours.
    sink.write('stderr', `${text.trimEnd()}\n`)
  } finally {
    sink.flush()
    clearInterrupt(interruptBuffer)
    post({ type: 'done', runId: message.runId, ok, interrupted })
  }
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data
  try {
    if (message.type === 'init') await init(message)
    if (message.type === 'run') await run(message)
  } catch (error) {
    post({
      type: 'fatal',
      message: error instanceof Error ? error.message : 'Python failed to start.',
    })
  }
}
