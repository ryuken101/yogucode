/**
 * One problem, worked by one child: the prompt and checks on the left, the editor and
 * terminal on the right.
 *
 * - **Run** runs their program, interactively, exactly like My files.
 * - **Check** runs it against the problem's tests in fresh globals (`grader.py`) and shows
 *   **"3 of 5 passing"** in `good` and `not-yet` — never red, never a wall of crosses (§3.4).
 * - **Hints** unlock in order, after enough runs or enough minutes. The server decides;
 *   the page only says how close the next one is.
 *
 * Both Run and Check are reported to the server: the run count gates hints, and the last
 * Check result is what the teacher's progress view shows. The code autosaves through the
 * same hook as a file, so leaving mid-sentence costs nothing.
 *
 * A problem with parts shows them as tabs. Each part is its own attempt — its checks,
 * hints and marks are its own, so part (b) can be done before part (a) (spec §3.3). On a
 * **shared file** (17 Oct 2026) the code is one program for every part: the editor, its
 * autosave and the live stream stay on the file's attempt while the tabs change, and a
 * Check runs the active part's checks against the whole file. Older problems keep code
 * per part.
 */

import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Button } from '../components/Button'
import { Console } from '../components/Console'
import { McqAttempt } from '../components/McqAttempt'
import { Dots } from '../components/Dots'
import { Markdown } from '../components/Markdown'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { CodeSurface } from '../editor/CodeSurface'
import { SaveControl } from '../editor/SaveControl'
import { useAutosave } from '../editor/useAutosave'
import { api, type Schemas } from '../lib/api'
import { messageFor } from '../lib/errors'
import { useStudentProblem } from '../lib/queries'
import { toChecks } from '../problems/doc'
import { ChecksPanel } from '../problems/ChecksPanel'
import { ProblemBrief } from '../problems/ProblemBrief'
import type { TestRun } from '../runtime/protocol'
import { studentLive } from '../collab/socket'
import { useLiveDoc } from '../collab/useLiveDoc'
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

/** Back to wherever this problem was opened from: the homework, the quiz, or Today. */
function BackLink({ mode, assignmentId }: { mode: string; assignmentId: string }) {
  if (mode === 'homework') {
    return (
      <Link to={`/homework/${assignmentId}`} className="text-sm text-grape-deep">
        ← Back to the homework
      </Link>
    )
  }
  if (mode === 'quiz') {
    return (
      <Link to={`/quiz/${assignmentId}`} className="text-sm text-grape-deep">
        ← Back to the quiz
      </Link>
    )
  }
  return (
    <Link to="/home" className="text-sm text-grape-deep">
      ← Today
    </Link>
  )
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

  const navigate = useNavigate()
  const leaf = leaves[active]
  const shared = Boolean(problem.data?.shared_file)
  // The attempt the editor is: the file's on a shared file, else the active part's.
  const fileAttemptId = shared ? (problem.data?.file_attempt_id ?? null) : (leaf?.attempt.id ?? null)
  // Where this visit's latest text is kept: one slot for a shared file, one per part else.
  const codeKey = shared ? 'file' : (leaf?.item_id ?? '')
  const startingCode = shared ? (leaves[0]?.attempt.code ?? '') : (leaf?.attempt.code ?? '')
  const autosave = useAutosave(fileAttemptId, (id, code) => api.saveAttempt(id, code))
  // The process trace (step 7): every edit, run, check, error and hint — on the file's
  // attempt for a shared file, so its edit history is one history.
  const record = useEventRecorder(fileAttemptId ? { attemptId: fileAttemptId } : null)
  const python = usePython({
    onRunFinished: ({ ok, interrupted, stderr }) => {
      if (!ok && !interrupted) {
        record('error', { text: stderr.slice(-2000) })
        studentLive().status({ kind: 'error', text: stderr.trim().split('\n').pop() ?? '' })
      }
    },
  })
  // A quiz ending: save now, before the hand-in snapshot; when it has ended, go to the
  // quiz page, which says the work has been handed in.
  const quizMode = problem.data?.mode === 'quiz'
  useEffect(
    () =>
      studentLive().onQuiz((message) => {
        autosave.flush()
        if (quizMode && message.type === 'quiz_ended') navigate(`/quiz/${assignmentId}`)
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [quizMode, assignmentId],
  )
  // The live classroom: this part's code streams to the teacher, who can type into it.
  const liveTarget = fileAttemptId ? `attempt:${fileAttemptId}` : null
  const live = useLiveDoc(liveTarget, leaf ? (latest.current[codeKey] ?? startingCode) : null)
  const title = problem.data
    ? `${problem.data.title}${leaf?.label ? ` (${leaf.label})` : ''}`
    : null
  useEffect(() => {
    if (!liveTarget || !title || !problem.data) return
    studentLive().setFocus({
      target: liveTarget,
      kind: 'problem',
      title,
      mode: problem.data.mode,
      assignment_id: problem.data.assignment_id,
    })
  }, [liveTarget, title, problem.data])

  useEffect(() => {
    if (problem.data) setLeaves(problem.data.leaves)
  }, [problem.data])

  useEffect(() => {
    if (fileAttemptId) autosave.adopt(fileAttemptId, latest.current[codeKey] ?? startingCode)
    // `adopt` is stable; re-adopt only when the file changes — on a shared file, never.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileAttemptId])

  if (problem.isPending) return <Spinner label="Opening the problem" />
  if (problem.error) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-10">
        <Notice tone="system-error">{messageFor(problem.error)}</Notice>
      </div>
    )
  }
  // Multiple choice: no editor, no Python — pick an answer.
  if (problem.data?.kind === 'mcq' && leaves[0]) {
    const answer = leaves[0]
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-8">
        <BackLink mode={problem.data.mode} assignmentId={assignmentId} />
        <div className="flex items-center gap-3">
          <Dots value={problem.data.difficulty} />
          <h1 className="font-display font-semibold text-xl text-grape">{problem.data.title}</h1>
        </div>
        <Markdown>{problem.data.prompt_md}</Markdown>
        <McqAttempt
          options={problem.data.options}
          initial={answer.attempt.choice}
          onChoose={async (choice) => {
            await api.choose(answer.attempt.id, choice)
            record('edit', { choice })
            studentLive().status({ kind: 'choice', target: `attempt:${answer.attempt.id}` })
          }}
        />
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
  const code = latest.current[codeKey] ?? startingCode
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
    studentLive().status({ kind: 'run', target: liveTarget })
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
      studentLive().status({
        kind: 'check',
        target: liveTarget,
        passed,
        total: outcome.results.length,
        compile_error: outcome.compile_error,
      })
      record('check', {
        ...(shared ? { part: leaf.label } : {}),
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
      studentLive().status({ kind: 'hint', target: liveTarget, level: updated.hints.length })
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
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto rounded-lg bg-surface p-4 ring-1 ring-line">
        <ProblemBrief
          top={<BackLink mode={data.mode} assignmentId={assignmentId} />}
          title={data.title}
          difficulty={data.difficulty}
          prompt_md={data.prompt_md}
          examples={data.examples}
          parts={leaves.map((part) => ({
            key: part.item_id,
            label: part.label,
            prompt_md: part.prompt_md,
            examples: part.examples,
          }))}
          active={active}
          onSelect={(index) => {
            autosave.flush()
            setActive(index)
            setHintMessage(null)
          }}
        />

        <ChecksPanel enabled={data.checks} count={leaf.tests.length} run={run} sharedFile={shared} />

        {leaf.hints.length > 0 || leaf.next_hint ? (
          <section aria-label="Hints" className="flex flex-col gap-2">
            <h2 className="font-display font-semibold text-lg text-grape">Hints</h2>
            {leaf.hints.map((hint) => (
              <div key={hint.level} className="rounded-lg bg-grape-pale/30 px-3 py-2 ring-1 ring-grape/20">
                <Markdown>{hint.body_md}</Markdown>
              </div>
            ))}
            {leaf.next_hint ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="secondary" onClick={() => void onHint()} disabled={waitFor !== null}>
                  {leaf.hints.length ? 'Another hint' : 'Get a hint'}
                </Button>
                {waitFor ? (
                  <span className="text-sm text-muted">Available {waitFor}.</span>
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
          {data.checks ? (
            <Button variant="secondary" onClick={() => void onCheck()} disabled={busy || loading}>
              {python.state.status === 'checking' ? 'Checking…' : 'Check'}
            </Button>
          ) : null}
          {python.state.status === 'loading' ? <Spinner label={python.state.detail} /> : null}
          {python.state.status === 'asking' ? (
            <span className="text-sm text-not-yet-ink">Your program is waiting for you to type.</span>
          ) : null}
          <SaveControl className="ml-auto" state={autosave.state} onSave={autosave.save} />
        </div>
        {autosave.state === 'failed' ? (
          <Notice tone="system-error">
            Your work is not saving. Tell your teacher — you may need to sign in again.
          </Notice>
        ) : null}
        {live.locked ? (
          <Notice tone="info">
            Your teacher is helping — watch your code. You can type again when they’re done.
          </Notice>
        ) : null}
        <div className="min-h-64 flex-[2] overflow-hidden rounded-lg ring-1 ring-grape/25">
          <CodeSurface
            onSave={autosave.save}
            // One editor per part: Monaco's undo stack must not carry one part's history
            // into another.
            key={codeKey}
            value={code}
            completions={data.completions}
            // Locked while the teacher helps (Ken's decision, 11 Oct 2026).
            readOnly={live.locked}
            onChange={(next) => {
              latest.current[codeKey] = next
              autosave.onChange(next)
            }}
            onModel={live.bind}
            onCursor={live.onCursor}
            onEdit={(changes) => record(live.isRemote() ? 'teacher_edit' : 'edit', { changes })}
            onPaste={(chars) => {
              record('paste', { chars })
              studentLive().status({ kind: 'paste', target: liveTarget, chars })
            }}
          />
        </div>
        <div className="min-h-32 flex-1">
          <Console segments={python.output} asking={python.state.status === 'asking'} onAnswer={python.answer} />
        </div>
      </div>
    </div>
  )
}
