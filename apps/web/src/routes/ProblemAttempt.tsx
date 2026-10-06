/**
 * One problem, worked by one child: the prompt and checks on the left, the editor and
 * terminal on the right.
 *
 * - **Run** runs their program, interactively, exactly like My files.
 * - **Check** runs it against the problem's tests in fresh globals (`grader.py`) and shows
 *   **"3 of 5 passing"** in sage and amber — never red, never a wall of crosses (§3.4).
 * - **Hints** unlock in order, after enough runs or enough minutes. The server decides;
 *   the page only says how close the next one is.
 *
 * Both Run and Check are reported to the server: the run count gates hints, and the last
 * Check result is what the teacher's progress view shows. The code autosaves through the
 * same hook as a file, so leaving mid-sentence costs nothing.
 *
 * A problem with parts shows them as tabs. Each part is its own attempt with its own code,
 * so part (b) can be done before part (a) — the point of parts (spec §3.3).
 */

import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { Button } from '../components/Button'
import { Console } from '../components/Console'
import { Dots } from '../components/Dots'
import { Markdown } from '../components/Markdown'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { CodeSurface } from '../editor/CodeSurface'
import { useAutosave } from '../editor/useAutosave'
import { api, type Schemas } from '../lib/api'
import { messageFor } from '../lib/errors'
import { useStudentProblem } from '../lib/queries'
import { toChecks } from '../problems/doc'
import { PassingSummary, TestResultLine } from '../problems/TestResults'
import type { TestRun } from '../runtime/protocol'
import { useEventRecorder } from '../events/recorder'
import { usePython } from '../runtime/usePython'

type Leaf = Schemas['StudentLeafOut']

function hintProgress(next: NonNullable<Leaf['next_hint']>, runsSinceOpen: number, since: number) {
  const runs = Math.max(0, next.runs_needed - runsSinceOpen)
  const seconds = Math.max(0, next.seconds_needed - (Date.now() - since) / 1000)
  if (next.available || runs === 0 || seconds === 0) return null
  const minutes = Math.ceil(seconds / 60)
  return `after ${runs} more run${runs === 1 ? '' : 's'}, or in about ${minutes} minute${minutes === 1 ? '' : 's'}`
}

export function ProblemAttempt() {
  const { assignmentId = '', itemId = '' } = useParams()
  const problem = useStudentProblem(assignmentId, itemId)

  const [leaves, setLeaves] = useState<Leaf[]>([])
  const [active, setActive] = useState(0)
  const [results, setResults] = useState<Record<string, TestRun | null>>({})
  const [hintMessage, setHintMessage] = useState<string | null>(null)
  const [runs, setRuns] = useState<Record<string, number>>({})
  const openedAt = useRef(Date.now())
  // The latest text of every part this visit, so switching tabs and back does not reopen
  // a part with the code it had when the page loaded.
  const latest = useRef<Record<string, string>>({})

  // Re-render every 15 s so "available in about 2 minutes" counts down, and the hint
  // button enables itself when the time comes, without the child having to do anything.
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 15_000)
    return () => clearInterval(timer)
  }, [])

  const leaf = leaves[active]
  const autosave = useAutosave(leaf?.attempt.id ?? null, (id, code) => api.saveAttempt(id, code))
  // The process trace for this part (step 7): every edit, run, check, error and hint.
  const record = useEventRecorder(leaf ? { attemptId: leaf.attempt.id } : null)
  const python = usePython({
    onRunFinished: ({ ok, interrupted, stderr }) => {
      if (!ok && !interrupted) record('error', { text: stderr.slice(-2000) })
    },
  })

  useEffect(() => {
    if (problem.data) setLeaves(problem.data.leaves)
  }, [problem.data])

  useEffect(() => {
    if (leaf) autosave.adopt(leaf.attempt.id, latest.current[leaf.item_id] ?? leaf.attempt.code)
    // `adopt` is stable; re-adopt only when the part changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaf?.attempt.id])

  if (problem.isPending) return <Spinner label="Opening the problem" />
  if (problem.error) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-10">
        <Notice tone="system-error">{messageFor(problem.error)}</Notice>
      </div>
    )
  }
  if (python.state.status === 'unsupported') {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16">
        <Notice tone="system-error">{python.state.reason}</Notice>
      </div>
    )
  }
  if (!leaf) return null

  const data = problem.data
  const code = latest.current[leaf.item_id] ?? leaf.attempt.code
  const busy = ['running', 'asking', 'checking'].includes(python.state.status)
  const loading = python.state.status === 'loading'
  const run = results[leaf.item_id]

  function countRun() {
    setRuns((current) => ({ ...current, [leaf.item_id]: (current[leaf.item_id] ?? 0) + 1 }))
  }

  function onRun() {
    autosave.flush()
    python.run(code)
    record('run')
    countRun()
    void api.recordRun(leaf.attempt.id).catch(() => undefined)
  }

  async function onCheck() {
    autosave.flush()
    const outcome = await python.check(code, toChecks(leaf.tests))
    setResults((current) => ({ ...current, [leaf.item_id]: outcome }))
    countRun()
    if (outcome) {
      const passed = outcome.results.filter((r) => r.passed).length
      record('check', {
        passed,
        total: outcome.results.length,
        compile_error: outcome.compile_error,
        // Which checks failed and why — what a teacher replaying this will want to see.
        failed: outcome.results
          .filter((r) => !r.passed)
          .map((r) => ({ name: r.name, error: r.error ?? null })),
      })
      void api
        .recordRun(leaf.attempt.id, { passed, total: outcome.results.length })
        .catch(() => undefined)
    }
  }

  async function onHint() {
    setHintMessage(null)
    try {
      const updated = await api.unlockHint(leaf.attempt.id)
      record('hint', { level: updated.hints.length })
      setLeaves((current) => current.map((l) => (l.item_id === updated.item_id ? updated : l)))
    } catch (error) {
      setHintMessage(messageFor(error))
    }
  }

  const waitFor = leaf.next_hint
    ? hintProgress(leaf.next_hint, runs[leaf.item_id] ?? 0, openedAt.current)
    : null

  return (
    <div className="grid h-full gap-3 p-3 lg:grid-cols-[2fr_3fr]">
      {/* Left: what to do, how it is going, and help. Scrolls on its own. */}
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto rounded-lg bg-paper p-4 ring-1 ring-ink/10">
        <div>
          {data.mode === 'homework' ? (
            <Link to={`/homework/${assignmentId}`} className="text-sm text-sky-deep">
              ← Back to the homework
            </Link>
          ) : (
            <Link to="/home" className="text-sm text-sky-deep">
              ← Today
            </Link>
          )}
          <div className="mt-2 flex items-center gap-3">
            <Dots value={data.difficulty} />
            <h1 className="font-serif text-xl text-ink">{data.title}</h1>
          </div>
          <Markdown>{data.prompt_md}</Markdown>
        </div>

        {leaves.length > 1 ? (
          <div role="tablist" aria-label="Parts" className="flex gap-1">
            {leaves.map((part, index) => (
              <button
                key={part.item_id}
                role="tab"
                aria-selected={index === active}
                onClick={() => {
                  autosave.flush()
                  setActive(index)
                  setHintMessage(null)
                }}
                className={`rounded-lg px-3 py-1.5 text-sm ring-1 ${
                  index === active ? 'bg-sky-pale ring-sky' : 'bg-paper ring-ink/15'
                }`}
              >
                Part ({part.label})
              </button>
            ))}
          </div>
        ) : null}
        {leaf.prompt_md ? <Markdown>{leaf.prompt_md}</Markdown> : null}

        <section aria-label="Checks" className="flex flex-col gap-2">
          <h2 className="font-serif text-lg text-ink">Checks</h2>
          {run === undefined ? (
            <p className="text-sm text-ink-soft">
              Press <strong>Check</strong> to see how your code does on {leaf.tests.length}{' '}
              check{leaf.tests.length === 1 ? '' : 's'}.
            </p>
          ) : run === null ? (
            <Notice tone="not-yet">The check was stopped before it finished.</Notice>
          ) : (
            <>
              <PassingSummary results={run.results} />
              {run.compile_error ? (
                <Notice tone="not-yet">Python could not read your code: {run.compile_error}</Notice>
              ) : (
                run.results.map((result, index) => <TestResultLine key={index} result={result} />)
              )}
            </>
          )}
        </section>

        {leaf.hints.length > 0 || leaf.next_hint ? (
          <section aria-label="Hints" className="flex flex-col gap-2">
            <h2 className="font-serif text-lg text-ink">Hints</h2>
            {leaf.hints.map((hint) => (
              <div key={hint.level} className="rounded-lg bg-sky-pale/30 px-3 py-2 ring-1 ring-sky/30">
                <Markdown>{hint.body_md}</Markdown>
              </div>
            ))}
            {leaf.next_hint ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="secondary" onClick={() => void onHint()} disabled={waitFor !== null}>
                  {leaf.hints.length ? 'Another hint' : 'Get a hint'}
                </Button>
                {waitFor ? (
                  <span className="text-sm text-ink-soft">Available {waitFor}.</span>
                ) : null}
              </div>
            ) : null}
            {hintMessage ? <Notice tone="not-yet">{hintMessage}</Notice> : null}
          </section>
        ) : null}
      </div>

      {/* Right: the editor and the terminal, as in My files. */}
      <div className="flex min-h-0 flex-col gap-2">
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button variant="primary" onClick={onRun} disabled={busy || loading}>
            {python.state.status === 'running' || python.state.status === 'asking' ? 'Running…' : 'Run'}
          </Button>
          <Button variant="secondary" onClick={python.stop} disabled={!busy}>
            Stop
          </Button>
          <Button variant="secondary" onClick={() => void onCheck()} disabled={busy || loading}>
            {python.state.status === 'checking' ? 'Checking…' : 'Check'}
          </Button>
          {python.state.status === 'loading' ? <Spinner label={python.state.detail} /> : null}
          {python.state.status === 'asking' ? (
            <span className="text-sm text-amber">Your program is waiting for you to type.</span>
          ) : null}
          <span className="ml-auto text-xs text-ink-soft" aria-live="polite">
            {autosave.state === 'saving' ? 'Saving…' : null}
            {autosave.state === 'saved' ? 'Saved' : null}
          </span>
        </div>
        {autosave.state === 'failed' ? (
          <Notice tone="system-error">
            Your work is not saving. Tell your teacher — you may need to sign in again.
          </Notice>
        ) : null}
        <div className="min-h-64 flex-[2] overflow-hidden rounded-lg ring-1 ring-ink/20">
          <CodeSurface
            // One editor per part: Monaco's undo stack must not carry one part's history
            // into another.
            key={leaf.item_id}
            value={code}
            completions={data.completions}
            onChange={(next) => {
              latest.current[leaf.item_id] = next
              autosave.onChange(next)
            }}
            onEdit={(changes) => record('edit', { changes })}
            onPaste={(chars) => record('paste', { chars })}
          />
        </div>
        <div className="min-h-32 flex-1">
          <Console segments={python.output} asking={python.state.status === 'asking'} onAnswer={python.answer} />
        </div>
      </div>
    </div>
  )
}
