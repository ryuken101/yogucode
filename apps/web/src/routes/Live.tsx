/**
 * The live classroom: a tile per child, their code as they type it.
 *
 * Ken's choice of layout (8 Oct 2026): a grid of everyone's code, not a list of who is
 * stuck — the stuck signals sit on the tiles instead (step 4). Clicking a tile opens it
 * full size; **Help** makes that editor yours as well as theirs, both typing at once,
 * merged by Yjs (`src/collab`). Help is never available during a quiz.
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
import { CodeSurface } from '../editor/CodeSurface'
import { MonacoYBinding } from '../collab/monacoBinding'
import { RemoteCaret } from '../collab/remoteCaret'
import { useLiveClass, type LiveDoc, type LiveStudent } from '../collab/useLiveClass'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { timeLeft } from '../lib/dates'
import { messageFor } from '../lib/errors'
import { keys, useClass, useClassQuizzes, useRoster } from '../lib/queries'
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
  onOpen,
}: {
  name: string
  student: LiveStudent | undefined
  doc: LiveDoc | undefined
  onOpen: () => void
}) {
  const online = Boolean(student?.online)
  const code = doc?.doc.getText('code').toString() ?? ''
  const check = student ? lastCheck(student) : null
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!online}
      className={`flex h-56 flex-col rounded-2xl bg-surface p-3 text-left ring-1 transition ${
        online ? 'ring-line hover:ring-grape' : 'opacity-50 ring-line'
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
        {student ? <Flags flags={flagsFor(student)} /> : null}
      </span>
    </button>
  )
}

function Expanded({
  student,
  doc,
  canHelp,
  childCursor,
  sendCursor,
  onClose,
}: {
  student: LiveStudent
  doc: LiveDoc | undefined
  canHelp: boolean
  childCursor: number | undefined
  sendCursor: (target: string, offset: number | null) => void
  onClose: () => void
}) {
  const [helping, setHelping] = useState(false)
  const caret = useRef<RemoteCaret | null>(null)
  const target = student.focus?.target ?? null

  // The child's cursor, drawn in this editor as it moves.
  useEffect(() => {
    caret.current?.show(childCursor ?? null)
  }, [childCursor])

  // Stop showing the teacher's cursor on the child's screen when help ends or the panel closes.
  useEffect(() => {
    if (!helping || !target) return
    return () => sendCursor(target, null)
  }, [helping, target, sendCursor])
  return (
    <Card className="mb-6">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="font-display font-semibold text-xl text-grape">{student.displayName}</h2>
        <span className="text-sm text-muted">{student.focus?.title ?? 'nothing open'}</span>
        <Flags flags={flagsFor(student)} />
        <span className="ml-auto flex gap-2">
          {canHelp && doc ? (
            <Button variant={helping ? 'primary' : 'secondary'} onClick={() => setHelping(!helping)}>
              {helping ? 'Done helping' : 'Help — type in their editor'}
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
      <div className="h-96 overflow-hidden rounded-lg ring-1 ring-grape/25">
        {doc ? (
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

/** The running quiz, if any: how long is left, and Stop. */
function QuizBar({ classId }: { classId: string }) {
  const client = useQueryClient()
  const quizzes = useClassQuizzes(classId)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [, setTick] = useState(0)
  const running = (quizzes.data ?? []).find((q) => q.running)

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      setTick((n) => n + 1)
      // When the clock runs out the server hands everyone in; pick up the new state.
      if (running.ends_at && new Date(running.ends_at).getTime() < Date.now()) {
        void client.invalidateQueries({ queryKey: keys.quizzes(classId) })
      }
    }, 1_000)
    return () => clearInterval(timer)
  }, [running, classId, client])

  if (!running || !running.ends_at) return null
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl bg-grape-pale/50 px-5 py-3 ring-1 ring-grape/25">
      <span className="font-display font-semibold text-lg text-grape">Quiz · {running.title}</span>
      <span className="font-mono text-xl text-grape" aria-label="time left">
        {timeLeft(running.ends_at)}
      </span>
      <span className="text-sm text-muted">left · help is off during a quiz</span>
      <Button
        variant="secondary"
        className="ml-auto"
        disabled={stopping}
        onClick={() => {
          setStopping(true)
          api
            .stopQuiz(running.id)
            .then(() => client.invalidateQueries({ queryKey: keys.quizzes(classId) }))
            .catch(setError)
            .finally(() => setStopping(false))
        }}
      >
        {stopping ? 'Stopping…' : 'Stop the quiz'}
      </Button>
      {error ? <Notice tone="system-error">{messageFor(error)}</Notice> : null}
    </div>
  )
}

export function Live() {
  const { classId = '' } = useParams()
  const klass = useClass(classId)
  const roster = useRoster(classId)
  const live = useLiveClass(classId)
  const [open, setOpen] = useState<string | null>(null)
  // "Quiet for 5 minutes" is about time passing, not about a message arriving.
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(timer)
  }, [])

  const opened = open ? live.students.get(open) : undefined
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

      <QuizBar classId={classId} />

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
          canHelp={canHelp}
          childCursor={opened.focus ? live.cursors.get(opened.focus.target) : undefined}
          sendCursor={live.sendCursor}
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
              onOpen={() => setOpen(entry.student_id)}
            />
          )
        })}
      </div>
    </>
  )
}
