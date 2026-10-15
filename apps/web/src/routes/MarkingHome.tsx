/**
 * The Marking app's front page for a class (16 Oct 2026): everything there is to mark, one
 * line each, newest first. Opening one goes to the marking screen the app already had
 * (`/assignments/:id/mark`), in the same window.
 *
 * A draft has nothing handed in, and a quiz can only be marked once it has finished, so
 * neither is listed.
 */

import { Link, useParams } from 'react-router'
import { Badge } from '../components/Badge'
import { EmptyState, PageHeader } from '../components/Card'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { formatDue } from '../lib/dates'
import { messageFor } from '../lib/errors'
import { useClassHomework, useClassQuizzes } from '../lib/queries'

export function MarkingHome() {
  const { classId = '' } = useParams()
  const homework = useClassHomework(classId)
  const quizzes = useClassQuizzes(classId)

  if (homework.isPending || quizzes.isPending) return <Spinner label="Loading work to mark" />
  const error = homework.error ?? quizzes.error
  if (error) return <Notice tone="system-error">{messageFor(error)}</Notice>

  const rows = [
    ...(homework.data ?? [])
      .filter((hw) => hw.status !== 'draft')
      .map((hw) => ({
        id: hw.id,
        title: hw.title,
        kind: 'Homework',
        detail: `due ${formatDue(hw.due_at)} · ${hw.handed_in}/${hw.students} handed in · ${hw.marked} marked`,
        waiting: hw.handed_in - hw.marked,
      })),
    ...(quizzes.data ?? [])
      .filter((quiz) => quiz.status === 'closed')
      .map((quiz) => ({ id: quiz.id, title: quiz.title, kind: 'Quiz', detail: 'Finished', waiting: 0 })),
  ]

  return (
    <>
      <PageHeader title="Marking" />
      {rows.length === 0 ? (
        <EmptyState title="Nothing to mark yet">
          Homework shows up here once it is set, and quizzes once they have finished.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                to={`/assignments/${row.id}/mark`}
                className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface px-5 py-4 ring-1 ring-line hover:ring-grape"
              >
                <span className="font-medium text-grape">{row.title}</span>
                <Badge variant="muted">{row.kind}</Badge>
                <span className="text-sm text-muted">{row.detail}</span>
                {row.waiting > 0 ? (
                  <span className="ml-auto">
                    <Badge variant="active">{row.waiting} to mark</Badge>
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
