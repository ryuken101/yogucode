/**
 * One child's homework, for their teacher: what was handed in, when, and the marks given.
 *
 * The teacher's view of the rubric numbers — the child never sees these (spec §3.7). Per
 * question, so a pattern ("Correct 2 on everything except the loops part") shows itself.
 * Phase 8 turns this into per-concept mastery.
 */

import { useParams } from 'react-router'
import { Badge } from '../components/Badge'
import { Card, EmptyState, PageHeader } from '../components/Card'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { formatDue } from '../lib/dates'
import { messageFor } from '../lib/errors'
import { useStudentHistory } from '../lib/queries'

export function StudentHistory() {
  const { studentId = '' } = useParams()
  const history = useStudentHistory(studentId)

  if (history.isPending) return <Spinner label="Loading" />
  if (history.error) return <Notice tone="system-error">{messageFor(history.error)}</Notice>

  return (
    <>
      <PageHeader title={history.data.display_name} />
      {history.data.homework.length === 0 ? (
        <EmptyState title="No homework yet">Their homework will appear here once they start one.</EmptyState>
      ) : null}
      {history.data.homework.map((hw) => (
        <Card key={hw.assignment_id} className="mb-4">
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <h2 className="font-serif text-lg text-ink">{hw.title}</h2>
            <span className="text-sm text-ink-soft">{hw.class_name}</span>
            <span className="text-sm text-ink-soft">due {formatDue(hw.due_at)}</span>
            {hw.handed_in_at ? (
              <span className="text-sm text-ink-soft">handed in {formatDue(hw.handed_in_at)}</span>
            ) : (
              <Badge variant="muted">not handed in</Badge>
            )}
            {hw.late ? <Badge variant="not-yet">Late</Badge> : null}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-ink-soft">
                <th className="py-1 font-medium">Question</th>
                <th className="py-1 font-medium">Correct</th>
                <th className="py-1 font-medium">Approach</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {hw.questions.map((q) => (
                <tr key={q.title} className="border-t border-ink/5">
                  <td className="py-1.5 text-ink">{q.title}</td>
                  <td className="py-1.5 text-ink">{q.correct ?? '—'}</td>
                  <td className="py-1.5 text-ink">{q.approach ?? '—'}</td>
                  <td className="py-1.5">
                    {q.correct !== null && !q.released ? <Badge variant="muted">not given back</Badge> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </>
  )
}
