/**
 * The live classroom: a tile per child, their code as they type it.
 *
 * Ken's choice of layout (8 Oct 2026): a grid of everyone's code, not a list of who is
 * stuck — the stuck signals sit on the tiles instead (step 4). Clicking a tile opens it
 * full size; **Help** makes that editor yours as well as theirs, both typing at once,
 * merged by Yjs (`src/collab`). Help is never available during a quiz; there, the open tile
 * goes through everything the child has saved, question by question (Ken, 6 Nov 2026).
 *
 * Children who are not connected still have a tile, greyed, so an empty seat is visible
 * rather than simply missing from the grid.
 */

import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card, PageHeader } from '../components/Card'
import { Notice } from '../components/Notice'
import { StopQuizButton } from '../components/QuizControls'
import { CodeSurface } from '../editor/CodeSurface'
import { MonacoYBinding } from '../collab/monacoBinding'
import { RemoteCaret } from '../collab/remoteCaret'
import { useLiveClass, type LiveDoc, type LiveStudent } from '../collab/useLiveClass'
import { useQueryClient } from '@tanstack/react-query'
import type { Schemas } from '../lib/api'
import { timeLeft } from '../lib/dates'
import {
  keys,
  useClass,
  useClassQuizzes,
  useQuizAnswers,
  useQuizSittings,
  useRoster,
  useTodaysWork,
} from '../lib/queries'
import { flagsFor, type Flag } from './liveFlags'

const FLAG_TONE: Record<Flag['tone'], 'not-yet' | 'good' | 'active'> = {
  attention: 'not-yet',
  done: 'good',
  info: 'active',
}

function Flags({ flags }: { flags: Flag[] }) {
  if (!flags.length) return null
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((flag) => (
        <Badge key={flag.label} variant={FLAG_TONE[flag.tone]}>
          {flag.label}
        </Badge>
      ))}
    </span>
  )
}

function lastCheck(student: LiveStudent): string | null {
  const check = [...student.recent].reverse().find((s) => s.kind === 'check' && s.target === student.focus?.target)
  if (!check || check.total === undefined) return null
  return check.compile_error ? 'does not run' : `${check.passed} of ${check.total} passing`
}

function Tile({
  name,
  student,
  doc,
  flags,
  finished,
  openable,
  onOpen,
}: {
  name: string
  student: LiveStudent | undefined
  doc: LiveDoc | undefined
  flags: Flag[]
  finished: boolean
  /** Not signed in, a tile has nothing to show — except what they saved during a quiz. */
  openable: boolean
  onOpen: () => void
}) {
  const online = Boolean(student?.online)
  const code = doc?.doc.getText('code').toString() ?? ''
  const check = student ? lastCheck(student) : null
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!openable}
      className={`flex h-56 flex-col rounded-2xl bg-surface p-3 text-left ring-1 transition ${
        online ? 'ring-line hover:ring-grape' : openable ? 'opacity-60 ring-line hover:ring-grape' : 'opacity-50 ring-line'
      }`}
    >
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className={`size-2 rounded-full ${online ? 'bg-good' : 'bg-muted/30'}`}
        />
        <span className="font-medium text-grape">{name}</span>
        <span className="ml-auto truncate text-xs text-muted">
          {online ? (student?.focus?.title ?? 'nothing open') : 'not signed in'}
        </span>
      </span>
      <pre className="mt-2 min-h-0 flex-1 overflow-hidden rounded-md bg-night p-2 font-mono text-[11px] leading-snug text-cream">
        {code || ' '}
      </pre>
      <span className="mt-2 flex min-h-6 flex-wrap items-center gap-2 text-xs text-muted">
        {check ? <span>{check}</span> : null}
        {finished ? <Badge variant="good">Finished</Badge> : null}
        <Flags flags={flags} />
      </span>
    </button>
  )
}

/** One question of a quiz as the child last saved it, for a question they don't have open. */
function SavedAnswer({ answer }: { answer: Schemas['QuizAnswerOut'] }) {
  if (answer.attempt_id === null) return <p className="p-4 text-sm text-muted">They haven’t opened this one.</p>
  if (answer.kind === 'mcq') {
    return (
      <ul className="flex flex-col gap-2 p-4">
        {answer.options.map((option, index) => (
          <li
            key={index}
            className={`flex flex-wrap items-center gap-3 rounded-2xl px-4 py-2 text-sm ring-1 ${
              answer.choice === index ? 'bg-grape-pale ring-2 ring-grape' : 'ring-line'
            }`}
          >
            <span className="min-w-0 whitespace-pre-wrap break-words font-mono text-grape">{option.text}</span>
            <span className="ml-auto flex gap-1">
              {answer.choice === index ? <Badge variant="active">Their answer</Badge> : null}
              {option.correct ? <Badge variant="good">right</Badge> : null}
              {answer.choice === index && !option.correct ? <Badge variant="not-yet">not yet</Badge> : null}
            </span>
          </li>
        ))}
        {answer.choice === null ? <li className="text-sm text-muted">They haven’t chosen an answer.</li> : null}
      </ul>
    )
  }
  return (
    <CodeSurface
      key={answer.item_id}
      value={answer.code ?? ''}
      onChange={() => undefined}
      readOnly
      autoFocus={false}
    />
  )
}

function Expanded({
  student,
  doc,
  flags,
  quizId,
  canHelp,
  childCursor,
  sendCursor,
  sendHelp,
  onClose,
}: {
  student: LiveStudent
  doc: LiveDoc | undefined
  flags: Flag[]
  /** The quiz running in this class, to go through what this child has saved for it. */
  quizId: string | null
  canHelp: boolean
  childCursor: number | undefined
  sendCursor: (target: string, offset: number | null) => void
  sendHelp: (target: string, on: boolean) => void
  onClose: () => void
}) {
  const [helping, setHelping] = useState(false)
  const caret = useRef<RemoteCaret | null>(null)
  const target = student.focus?.target ?? null
  const answers = useQuizAnswers(quizId, student.studentId)
  // The question picked here; until one is, whichever the child has open, as it moves.
  const [picked, setPicked] = useState<string | null>(null)
  const questions = quizId ? (answers.data ?? []) : []
  const here = questions.find((a) => a.attempt_id && `attempt:${a.attempt_id}` === target)
  const shown = questions.find((a) => a.item_id === picked) ?? here ?? questions[0]
  // The code question they are in is the live editor; the rest are their saved work. A
  // multiple-choice question has an empty document behind it, and nothing to watch being typed.
  const showSaved = shown !== undefined && !(shown === here && doc && shown.kind !== 'mcq')

  // The child's cursor, drawn in this editor as it moves.
  useEffect(() => {
    caret.current?.show(childCursor ?? null)
  }, [childCursor])

  // Stop showing the teacher's cursor on the child's screen when help ends or the panel closes.
  useEffect(() => {
    if (!helping || !target) return
    return () => sendCursor(target, null)
  }, [helping, target, sendCursor])

  // Lock the child's editor while helping. The cleanup unlocks it on Done helping, on
  // closing this panel, when the child switches file, and when the page goes — and the
  // server unlocks it too if this connection drops, so a child is never left stuck.
  useEffect(() => {
    if (!helping || !target) return
    sendHelp(target, true)
    return () => sendHelp(target, false)
  }, [helping, target, sendHelp])
  return (
    <Card className="mb-6">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="font-display font-semibold text-xl text-grape">{student.displayName}</h2>
        <span className="text-sm text-muted">{student.focus?.title ?? 'nothing open'}</span>
        <Flags flags={flags} />
        <span className="ml-auto flex gap-2">
          {canHelp && doc ? (
            <Button variant={helping ? 'primary' : 'secondary'} onClick={() => setHelping(!helping)}>
              {helping ? 'Done helping' : 'Help — take over their editor'}
            </Button>
          ) : null}
          <Button variant="quiet" onClick={onClose}>
            Close
          </Button>
        </span>
      </div>
      {helping ? (
        <p className="mb-2 text-sm text-muted">
          You and {student.displayName} are both typing in this editor. What you type appears on
          their screen straight away.
        </p>
      ) : null}
      {questions.length ? (
        <div role="tablist" aria-label="Questions" className="mb-3 flex flex-wrap gap-1.5">
          {questions.map((question, index) => (
            <button
              key={question.item_id}
              type="button"
              role="tab"
              aria-selected={question === shown}
              onClick={() => setPicked(question.item_id)}
              className={`flex max-w-80 items-center gap-1 rounded-full px-3 py-1 text-sm font-medium ring-1 ${
                question === shown ? 'bg-grape text-surface ring-grape' : 'text-grape ring-line hover:ring-grape'
              }`}
            >
              <span className="truncate">
                {index + 1}. {question.title}
              </span>
              <span className="shrink-0">
                {question === here ? '· open now' : question.answered ? '· answered' : ''}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <div className={`h-96 rounded-lg ring-1 ring-grape/25 ${showSaved && shown.kind === 'mcq' ? 'overflow-auto' : 'overflow-hidden'}`}>
        {showSaved ? (
          <SavedAnswer answer={shown} />
        ) : doc ? (
          <CodeSurface
            // A new document (the child reloaded) needs a new editor bound to it.
            key={`${student.focus?.target}-${doc.doc.guid}`}
            value={doc.doc.getText('code').toString()}
            onChange={() => undefined}
            readOnly={!helping}
            autoFocus={false}
            onModel={(model) => {
              const binding = new MonacoYBinding(doc.doc.getText('code'), model)
              caret.current = new RemoteCaret(model, student.displayName)
              caret.current.show(childCursor ?? null)
              return () => {
                binding.dispose()
                caret.current?.dispose()
                caret.current = null
              }
            }}
            onCursor={(offset) => {
              if (helping && target) sendCursor(target, offset)
            }}
          />
        ) : (
          <p className="p-4 text-sm text-muted">Their editor hasn’t sent anything yet.</p>
        )}
      </div>
    </Card>
  )
}

/** The running quiz: how long is left, whether everyone has finished, and Stop. */
function QuizBar({ running, classId, allFinished }: { running: Schemas['QuizOut']; classId: string; allFinished: boolean }) {
  const client = useQueryClient()
  const [now, setNow] = useState(() => Date.now())
  const over = running.ends_at ? new Date(running.ends_at).getTime() < now : false

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
      // When the clock runs out the server hands everyone in; pick up the new state.
      if (running.ends_at && new Date(running.ends_at).getTime() < Date.now()) {
        void client.invalidateQueries({ queryKey: keys.quizzes(classId) })
      }
    }, 1_000)
    return () => clearInterval(timer)
  }, [running, classId, client])

  if (!running.ends_at) return null
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl bg-grape-pale/50 px-5 py-3 ring-1 ring-grape/25">
      <span className="min-w-0 break-words font-display font-semibold text-lg text-grape [overflow-wrap:anywhere]">
        Quiz · {running.title}
      </span>
      <span className="font-mono text-xl text-grape" aria-label="time left">
        {timeLeft(running.ends_at, now)}
      </span>
      <span className="text-sm text-muted">
        {over ? 'time’s up · handing in everyone’s work' : 'left · help is off during a quiz'}
      </span>
      {allFinished ? <Badge variant="good">All finished</Badge> : null}
      {over ? null : <StopQuizButton quiz={running} className="ml-auto" />}
    </div>
  )
}

export function Live() {
  const { classId = '' } = useParams()
  const klass = useClass(classId)
  const roster = useRoster(classId)
  const live = useLiveClass(classId)
  const quizzes = useClassQuizzes(classId)
  const running = (quizzes.data ?? []).find((q) => q.running) ?? null
  const sittings = useQuizSittings(running?.id ?? null)
  const todaysWork = useTodaysWork(classId)
  const [open, setOpen] = useState<string | null>(null)
  // "Quiet for 5 minutes" and "left the page · 12s" are about time passing, not about a
  // message arriving; the second one counts seconds while anyone is away.
  const [now, setNow] = useState(() => Date.now())
  const anyoneAway = [...live.students.values()].some((s) => s.online && s.awaySince !== null)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), anyoneAway ? 1_000 : 30_000)
    return () => clearInterval(timer)
  }, [anyoneAway])

  const sittingOf = (studentId: string) => sittings.data?.find((s) => s.student_id === studentId)
  const flagsOf = (student: LiveStudent | undefined) =>
    student
      ? flagsFor(student, now, {
          todaysWork: running ? null : todaysWork.data?.assignment_id,
          timesLeft: running ? (sittingOf(student.studentId)?.away_count ?? 0) : undefined,
        })
      : []
  const connected = [...live.students.values()].filter((s) => s.online)
  const allFinished =
    connected.length > 0 && connected.every((s) => Boolean(sittingOf(s.studentId)?.finished_at))

  // During a quiz a child who isn't connected can still be opened, for what they saved.
  const rosterEntry = (roster.data ?? []).find((entry) => entry.student_id === open)
  const opened: LiveStudent | undefined = open
    ? live.students.get(open)?.online
      ? live.students.get(open)
      : running && rosterEntry
        ? {
            studentId: open,
            displayName: rosterEntry.display_name,
            online: false,
            focus: null,
            recent: [],
            lastEditAt: null,
            awaySince: null,
            awayCount: 0,
            awayTotal: 0,
          }
        : undefined
    : undefined
  const docFor = (student: LiveStudent | undefined) =>
    student?.focus ? live.docs.get(student.focus.target) : undefined
  // Help is for classwork; never into an editor a quiz is being sat in.
  const canHelp = opened?.focus?.mode !== 'quiz'

  return (
    <>
      <PageHeader title={klass.data ? `${klass.data.name} — live` : 'Live'}>
        <span className="text-sm text-muted">
          {live.state === 'live'
            ? `${[...live.students.values()].filter((s) => s.online).length} connected`
            : live.state === 'refused'
              ? ''
              : 'Connecting…'}
        </span>
        <Link to={`/classes/${classId}`} className="text-sm text-grape-deep">
          Back to the class
        </Link>
      </PageHeader>

      {running ? <QuizBar running={running} classId={classId} allFinished={allFinished} /> : null}

      {live.state === 'refused' ? (
        <Notice tone="system-error">Could not open the live view. Sign in again and reload.</Notice>
      ) : null}
      {live.state === 'reconnecting' ? (
        <div className="mb-4">
          <Notice tone="info">The live connection dropped — reconnecting…</Notice>
        </div>
      ) : null}

      {opened ? (
        <Expanded
          key={opened.studentId}
          student={opened}
          doc={docFor(opened)}
          flags={flagsOf(opened)}
          quizId={running?.id ?? null}
          canHelp={canHelp && !running}
          childCursor={opened.focus ? live.cursors.get(opened.focus.target) : undefined}
          sendCursor={live.sendCursor}
          sendHelp={live.sendHelp}
          onClose={() => setOpen(null)}
        />
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(roster.data ?? []).map((entry) => {
          const student = live.students.get(entry.student_id)
          return (
            <Tile
              key={entry.student_id}
              name={entry.display_name}
              student={student}
              doc={docFor(student)}
              flags={flagsOf(student)}
              finished={Boolean(sittingOf(entry.student_id)?.finished_at)}
              openable={Boolean(student?.online) || running !== null}
              onOpen={() => setOpen(entry.student_id)}
            />
          )
        })}
      </div>
    </>
  )
}
