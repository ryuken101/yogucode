/**
 * The page's side of the Python runtime.
 *
 * Owns one worker for the lifetime of the editor, so a child's variables survive between
 * runs and a Stop costs nothing. The worker is created lazily on the first run rather than
 * on mount: 5.7 MB should be fetched because someone pressed Run, not because they opened
 * a page.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  answerStdin,
  cancelStdin,
  createInterruptBuffer,
  createStdinBuffer,
  isWaitingForStdin,
  isolated,
  signalInterrupt,
} from './channel'
import { MAX_OUTPUT_CHARS, type FromWorker, type TestCheck, type TestRun } from './protocol'

export interface OutputSegment {
  /** `stdin` is the terminal echo of what the child typed, not something Python wrote. */
  stream: 'stdout' | 'stderr' | 'stdin' | 'system'
  text: string
}

/**
 * Keep the newest output and drop the oldest, the way a terminal's scrollback does.
 *
 * The case this is for: a child writes `for i in range(5000): print(i)` and wants to watch
 * it reach 4999. Capping at the *start* would show them 0..1999 and no ending — the half
 * of the output they did not print it for.
 */
function trimToNewest(segments: OutputSegment[]): OutputSegment[] {
  let total = 0
  for (const segment of segments) total += segment.text.length
  if (total <= MAX_OUTPUT_CHARS) return segments

  let excess = total - MAX_OUTPUT_CHARS
  const kept: OutputSegment[] = []
  for (const segment of segments) {
    if (excess <= 0) {
      kept.push(segment)
      continue
    }
    if (segment.text.length <= excess) {
      excess -= segment.text.length
      continue
    }
    kept.push({ ...segment, text: segment.text.slice(excess) })
    excess = 0
  }
  return [
    { stream: 'system', text: '── earlier output dropped ──\n' },
    ...kept,
  ]
}

export type RunState =
  | { status: 'idle' }
  | { status: 'loading'; detail: string }
  | { status: 'running' }
  /** Parked at an `input()` prompt, waiting for the child to type something. */
  | { status: 'asking' }
  /** Running the problem's tests. The console is left alone; results come back by promise. */
  | { status: 'checking' }
  | { status: 'unsupported'; reason: string }

const INDEX_URL = '/pyodide/'

export interface RunFinished {
  ok: boolean
  interrupted: boolean
  /** What the program wrote to stderr — the traceback, when `ok` is false. */
  stderr: string
}

export function usePython({ onRunFinished }: { onRunFinished?: (run: RunFinished) => void } = {}) {
  // The newest callback, read when a run ends; held in a ref so the worker's message
  // handler never needs re-binding.
  const finished = useRef(onRunFinished)
  useEffect(() => {
    finished.current = onRunFinished
  })
  /** stderr of the run in progress, for `onRunFinished`. */
  const stderrOfRun = useRef('')
  const worker = useRef<Worker | null>(null)
  /** False until the worker has reported `ready`; a run before then is queued there. */
  const ready = useRef(false)
  const interrupt = useRef<Uint8Array | null>(null)
  const stdin = useRef<SharedArrayBuffer | null>(null)
  const runId = useRef(0)
  /** True when a run is waiting on the worker's boot to finish. */
  const pendingRun = useRef(false)
  /** Checks in flight, by runId — a check answers by promise rather than into the console. */
  const pendingChecks = useRef(new Map<number, (run: TestRun | null) => void>())

  const [state, setState] = useState<RunState>(() =>
    isolated()
      ? { status: 'idle' }
      : {
          status: 'unsupported',
          // Said plainly rather than hidden: without isolation, input() would hang forever
          // and Stop would do nothing, so offering Run at all would be a lie.
          reason:
            'This page is not running in a secure enough context to run Python. ' +
            'Reload, and tell your teacher if it keeps happening.',
        },
  )
  const [output, setOutput] = useState<OutputSegment[]>([])

  const append = useCallback((segment: OutputSegment) => {
    setOutput((segments) => trimToNewest([...segments, segment]))
  }, [])

  useEffect(
    () => () => {
      worker.current?.terminate()
      worker.current = null
    },
    [],
  )

  const ensureWorker = useCallback((): Worker => {
    if (worker.current) return worker.current

    ready.current = false
    interrupt.current = createInterruptBuffer()
    stdin.current = createStdinBuffer()
    const created = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })

    created.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data
      switch (message.type) {
        case 'loading':
          setState({ status: 'loading', detail: message.detail })
          break
        case 'ready':
          ready.current = true
          // If a run was queued during boot the worker is already executing it, so the
          // state must not drop back to idle and re-enable the Run button underneath it.
          setState((current) =>
            current.status === 'loading' && pendingRun.current
              ? { status: pendingChecks.current.size ? 'checking' : 'running' }
              : { status: 'idle' },
          )
          pendingRun.current = false
          break
        case 'stdout':
        case 'stderr':
          if (message.type === 'stderr') stderrOfRun.current += message.text
          append({ stream: message.type, text: message.text })
          break
        case 'stdin':
          setState({ status: 'asking' })
          break
        case 'truncated':
          append({
            stream: 'system',
            text: '\n── this program printed too much to keep up with ──\n',
          })
          break
        case 'done':
          setState({ status: 'idle' })
          finished.current?.({
            ok: message.ok,
            interrupted: message.interrupted,
            stderr: stderrOfRun.current,
          })
          stderrOfRun.current = ''
          break
        case 'checked': {
          const resolve = pendingChecks.current.get(message.runId)
          pendingChecks.current.delete(message.runId)
          resolve?.(message.run)
          setState({ status: 'idle' })
          break
        }
        case 'fatal':
          setState({ status: 'unsupported', reason: message.message })
          for (const resolve of pendingChecks.current.values()) resolve(null)
          pendingChecks.current.clear()
          break
      }
    }
    created.onerror = () => {
      setState({ status: 'unsupported', reason: 'Python could not start.' })
      // Nothing is coming back for a check in flight; let its caller move on.
      for (const resolve of pendingChecks.current.values()) resolve(null)
      pendingChecks.current.clear()
    }

    created.postMessage({
      type: 'init',
      indexURL: INDEX_URL,
      interrupt: interrupt.current,
      stdin: stdin.current,
    })
    worker.current = created
    return created
  }, [append])

  const run = useCallback(
    (code: string) => {
      if (state.status === 'unsupported') return
      setOutput([])
      runId.current += 1
      const created = ensureWorker()

      // On a cold page the first Run arrives while Pyodide is still downloading. The
      // worker holds the run and executes it the moment it is ready, so the child presses
      // Run **once** — pressing it and being told to press it again was the bug here.
      if (!ready.current) {
        pendingRun.current = true
        setState({ status: 'loading', detail: 'Starting Python' })
      } else {
        setState({ status: 'running' })
      }
      created.postMessage({ type: 'run', runId: runId.current, code })
    },
    [ensureWorker, state.status],
  )

  /**
   * Run the problem's tests against `code`. Resolves with the results, or null if the
   * check was stopped or Python could not start.
   *
   * Leaves the console alone — a child who printed something useful should not lose it
   * to pressing "Check" — and leaves their session's variables alone too (`grader.py`).
   */
  const check = useCallback(
    (code: string, tests: TestCheck[]): Promise<TestRun | null> => {
      if (state.status === 'unsupported') return Promise.resolve(null)
      runId.current += 1
      const id = runId.current
      const created = ensureWorker()
      if (!ready.current) {
        pendingRun.current = true
        setState({ status: 'loading', detail: 'Starting Python' })
      } else {
        setState({ status: 'checking' })
      }
      return new Promise((resolve) => {
        pendingChecks.current.set(id, resolve)
        created.postMessage({ type: 'check', runId: id, code, tests })
      })
    },
    [ensureWorker, state.status],
  )

  const answer = useCallback(
    (text: string) => {
      if (!stdin.current) return
      // Echo it, because a terminal shows you what you typed and the transcript should
      // read back as the conversation it was.
      append({ stream: 'stdin', text: `${text}\n` })
      setState({ status: 'running' })
      answerStdin(stdin.current, text)
    },
    [append],
  )

  /**
   * Stop, by whichever route applies.
   *
   * A program blocked at an `input()` prompt is **not executing Python**, so Pyodide never
   * looks at the interrupt buffer — that case has to be unblocked through the stdin
   * channel. Getting this wrong leaves a child pressing a Stop button that does nothing,
   * which is the failure this branch exists to prevent.
   */
  const stop = useCallback(() => {
    if (stdin.current && isWaitingForStdin(stdin.current)) {
      cancelStdin(stdin.current)
      return
    }
    if (interrupt.current) signalInterrupt(interrupt.current)
  }, [])

  return { state, output, run, check, stop, answer }
}
