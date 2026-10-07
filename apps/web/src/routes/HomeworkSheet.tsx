/**
 * One homework, as a child sees it: the problems, how far they have got, and Hand in.
 *
 * **Hand in checks first** (Ken's decision). Pressing it runs every problem's checks in
 * this browser and shows the result — "Q1 2 of 2 passing, Q2 not started" — with a last
 * chance to keep working. Then one hand-in for the whole sheet. They may hand in again
 * until their teacher gives it back; after that the sheet is read-only and shows the
 * feedback: a comment and a colour per question, sage or amber, never a number.
 */

import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { Dialog } from '../components/Dialog'
import { Dots } from '../components/Dots'
import { Markdown } from '../components/Markdown'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { recorder } from '../events/recorder'
import { api, type Schemas } from '../lib/api'
import { formatDue } from '../lib/dates'
import { messageFor } from '../lib/errors'
import { keys, useSheet } from '../lib/queries'
import { toChecks } from '../problems/doc'
import { usePython } from '../runtime/usePython'

interface Ready {
  title: string
  attemptId: string
  passed: number
  total: number
  started: boolean
  /** Multiple choice: answered or not — never checked here, that would give it away. */
  mcq: boolean
}

/** Work that has been given back: the teacher's note, then each question's comment and colour. */
export function Returned({ sheet }: { sheet: Schemas['SheetOut'] }) {
  return (
    <div className="flex flex-col gap-4">
      {sheet.note ? (
        <div className="rounded-xl bg-sky-pale/40 px-5 py-4 ring-1 ring-sky/30">
          <p className="mb-1 text-sm font-medium text-ink-soft">From your teacher</p>
          <p className="text-ink">{sheet.note}</p>
        </div>
      ) : null}
      {sheet.leaves.map((leaf) => {
        const good = leaf.feedback?.outcome === 'good'
        return (
          <Card key={leaf.leaf_item_id}>
            <div className="mb-3 flex items-center gap-3">
              <Dots value={leaf.difficulty} />
              <h2 className="font-serif text-lg text-ink">{leaf.title}</h2>
              {leaf.feedback ? (
                <span className="ml-auto">
                  <Badge variant={good ? 'good' : 'not-yet'}>{good ? 'Spot on' : 'Not yet'}</Badge>
                </span>
              ) : null}
            </div>
            {leaf.feedback?.comment_md ? (
              <div
                className={`mb-3 rounded-lg px-4 py-2 ring-1 ${
                  good ? 'bg-sage/10 ring-sage/40' : 'bg-amber/10 ring-amber/40'
                }`}
              >
                <Markdown>{leaf.feedback.comment_md}</Markdown>
              </div>
            ) : null}
            {leaf.feedback?.answer ? (
              <p className="text-sm text-ink">
                Your answer: <span className="font-mono">{leaf.feedback.answer}</span>
              </p>
            ) : leaf.feedback ? (
              <pre className="overflow-x-auto rounded-lg bg-ink-deep p-3 font-mono text-sm text-cream">
                {leaf.feedback.code || '(nothing written)'}
              </pre>
            ) : (
              <p className="text-sm text-ink-soft">Your teacher hasn’t written about this one.</p>
            )}
          </Card>
        )
      })}
    </div>
  )
}

export function HomeworkSheet() {
  const { assignmentId = '' } = useParams()
  const sheet = useSheet(assignmentId)
  const python = usePython()
  const client = useQueryClient()
  const [ready, setReady] = useState<Ready[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [handingIn, setHandingIn] = useState(false)

  if (sheet.isPending) return <Spinner label="Opening your homework" />
  if (sheet.error) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <Notice tone="system-error">{messageFor(sheet.error)}</Notice>
      </div>
    )
  }
  const data = sheet.data

  /** Run every problem's checks on what is saved, then ask. */
  async function prepare() {
    setChecking(true)
    setError(null)
    try {
      const notStarted = new Set(
        data.leaves.filter((l) => l.progress === 'not_started').map((l) => l.leaf_item_id),
      )
      const titles = new Map(data.leaves.map((l) => [l.leaf_item_id, l.title]))
      const rows: Ready[] = []
      for (const problemId of new Set(data.leaves.map((l) => l.problem_id))) {
        const problem = await api.openProblem(assignmentId, problemId)
        for (const leaf of problem.leaves) {
          if (problem.kind === 'mcq') {
            rows.push({
              title: titles.get(leaf.item_id) ?? problem.title,
              attemptId: leaf.attempt.id,
              passed: 0,
              total: 0,
              started: leaf.attempt.choice !== null,
              mcq: true,
            })
            continue
          }
          const run = await python.check(leaf.attempt.code, toChecks(leaf.tests))
          rows.push({
            title: titles.get(leaf.item_id) ?? problem.title,
            attemptId: leaf.attempt.id,
            passed: run ? run.results.filter((r) => r.passed).length : 0,
            total: run ? run.results.length : leaf.tests.length,
            started: !notStarted.has(leaf.item_id),
            mcq: false,
          })
        }
      }
      setReady(rows)
    } catch (caught) {
      setError(caught)
    } finally {
      setChecking(false)
    }
  }

  async function handIn() {
    if (!ready) return
    setHandingIn(true)
    try {
      const updated = await api.handIn(
        assignmentId,
        ready.map((r) => ({ attempt_id: r.attemptId, passed: r.passed, total: r.total })),
      )
      for (const row of ready) {
        recorder().record({ attemptId: row.attemptId }, 'submit', {
          passed: row.passed,
          total: row.total,
        })
      }
      client.setQueryData(keys.sheet(assignmentId), updated)
      await client.invalidateQueries({ queryKey: keys.home })
      setReady(null)
    } catch (caught) {
      setError(caught)
      setReady(null)
    } finally {
      setHandingIn(false)
    }
  }

  const unavailable = python.state.status === 'unsupported'
  const anyChanged = data.leaves.some((l) => l.changed_since_hand_in)

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-8">
      <div>
        <Link to="/home" className="text-sm text-sky-deep">
          ← Home
        </Link>
        <h1 className="mt-2 font-serif text-2xl text-ink">{data.title}</h1>
        <p className="text-sm text-ink-soft">Due {formatDue(data.due_at)}</p>
      </div>

      {data.returned ? (
        <Returned sheet={data} />
      ) : (
        <>
          {data.closed ? (
            <Notice tone="info">Your teacher has closed this homework, so it can’t be handed in now.</Notice>
          ) : null}
          {data.handed_in_at ? (
            <Notice tone="good">
              Handed in {formatDue(data.handed_in_at)}
              {data.late ? ', after the due date' : ''}.{' '}
              {anyChanged ? 'You’ve changed it since — hand in again to send the new version.' : 'You can still change it and hand in again.'}
            </Notice>
          ) : null}

          <ol className="flex flex-col gap-2">
            {data.leaves.map((leaf) => (
              <li key={leaf.leaf_item_id}>
                <Link
                  to={`/lesson/${assignmentId}/${leaf.problem_id}`}
                  className="flex items-center gap-4 rounded-xl bg-paper px-5 py-4 ring-1 ring-ink/10 hover:ring-sky"
                >
                  <Dots value={leaf.difficulty} />
                  <span className="font-medium text-ink">{leaf.title}</span>
                  <span className="ml-auto">
                    {leaf.progress === 'passing' ? <Badge variant="good">All checks pass</Badge> : null}
                    {leaf.progress === 'started' ? <Badge variant="active">Started</Badge> : null}
                  </span>
                </Link>
              </li>
            ))}
          </ol>

          {!data.closed ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                disabled={checking || unavailable}
                onClick={() => void prepare()}
              >
                {checking ? 'Checking your work…' : data.handed_in_at ? 'Hand in again' : 'Hand in'}
              </Button>
              {unavailable ? (
                <span className="text-sm text-ink-soft">This browser can’t run Python, so it can’t check your work.</span>
              ) : null}
            </div>
          ) : null}
          {error ? <Notice tone="not-yet">{messageFor(error)}</Notice> : null}
        </>
      )}

      <Dialog
        open={ready !== null}
        title={`Hand in “${data.title}”?`}
        onClose={() => setReady(null)}
        confirm={{
          label: handingIn ? 'Handing in…' : 'Hand in',
          disabled: handingIn,
          onConfirm: () => void handIn(),
        }}
      >
        <table className="w-full text-sm">
          <tbody>
            {(ready ?? []).map((row) => (
              <tr key={row.attemptId} className="border-b border-ink/5 last:border-0">
                <td className="py-1.5 pr-3 text-ink">{row.title}</td>
                <td
                  className={`py-1.5 text-right ${
                    row.started && row.total > 0 && row.passed === row.total ? 'text-sage' : 'text-ink-soft'
                  }`}
                >
                  {row.mcq
                    ? row.started
                      ? 'answered'
                      : 'not answered'
                    : row.started
                      ? `${row.passed} of ${row.total} passing`
                      : 'not started'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-ink-soft">
          You can keep working and hand in again until your teacher gives it back.
        </p>
      </Dialog>
    </div>
  )
}
