/**
 * A class at a glance: today's ladder and each homework, students × problems.
 *
 * Today's grid is the first place a teacher can *see* a fast finisher without walking the
 * room — spec §1.2's whole problem. Homework grids answer "who hasn't done it" in one look.
 * Refresh to update; live updating is Phase 10.
 *
 * Tones follow the palette rule: grape while working, `good` when done, muted for not
 * started. No error colour anywhere — not having started is not an error.
 */

import { useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card, PageHeader } from '../components/Card'
import { Dots } from '../components/Dots'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import type { Schemas } from '../lib/api'
import { formatDue } from '../lib/dates'
import { messageFor } from '../lib/errors'
import { useClass, useClassHomework, useHomeworkGrid, useTodayGrid } from '../lib/queries'

type Status = Schemas['GridCellOut']['status']

const CELL: Record<Status, { label: string; className: string }> = {
  not_started: { label: '·', className: 'bg-cream text-muted ring-muted/20' },
  started: { label: 'working', className: 'bg-grape-pale/60 text-grape ring-grape/25' },
  passing: { label: '✓ passing', className: 'bg-good/15 text-grape ring-good/60' },
  handed_in: { label: 'handed in', className: 'bg-grape-pale text-grape ring-grape' },
  marked: { label: 'marked', className: 'bg-good/15 text-grape ring-good/60' },
  returned: { label: 'given back', className: 'bg-good/25 text-grape ring-good/70' },
}

export function Cell({ cell, to }: { cell: Schemas['GridCellOut']; to?: string }) {
  const { label, className } = CELL[cell.status]
  const body = (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs ring-1 ${className}`}>
      {label}
      {cell.late ? <span className="text-not-yet-ink">· late</span> : null}
    </span>
  )
  return to ? <Link to={to}>{body}</Link> : body
}

function Grid({
  grid,
  linkFor,
  showFinished = false,
}: {
  grid: Schemas['GridOut']
  linkFor?: (column: Schemas['GridColumnOut']) => string
  showFinished?: boolean
}) {
  if (grid.rows.length === 0) return <p className="text-sm text-muted">Nobody in this class yet.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="py-2 pr-4 text-left font-medium text-muted">Student</th>
            {grid.columns.map((column) => (
              <th key={column.item_id} className="px-2 py-2 text-left font-medium text-muted">
                <span className="flex items-center gap-1.5">
                  <Dots value={column.difficulty} />
                  {column.title}
                </span>
              </th>
            ))}
            {showFinished ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {grid.rows.map((row) => (
            <tr key={row.student_id} className="border-t border-line">
              <td className="py-1.5 pr-4">
                <Link to={`/students/${row.student_id}`} className="text-grape hover:text-grape-deep hover:underline">
                  {row.display_name}
                </Link>
              </td>
              {row.cells.map((cell, i) => (
                <td key={grid.columns[i]!.item_id} className="px-2 py-1.5">
                  <Cell cell={cell} to={linkFor?.(grid.columns[i]!)} />
                </td>
              ))}
              {showFinished ? (
                <td className="px-2">
                  {row.finished ? <Badge variant="good">Finished — ready for more</Badge> : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function HomeworkGrid({ homework }: { homework: Schemas['HomeworkOut'] }) {
  const grid = useHomeworkGrid(homework.id)
  return (
    <Card className="mb-6">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="font-display font-semibold text-lg text-grape">{homework.title}</h2>
        <span className="text-sm text-muted">due {formatDue(homework.due_at)}</span>
        <span className="text-sm text-muted">
          {homework.handed_in}/{homework.students} handed in
        </span>
        <Link to={`/assignments/${homework.id}/mark`} className="ml-auto text-sm text-grape-deep">
          Mark →
        </Link>
      </div>
      {grid.isPending ? <Spinner label="Loading" /> : null}
      {grid.data ? (
        <Grid grid={grid.data} linkFor={(column) => `/assignments/${homework.id}/mark/${column.item_id}`} />
      ) : null}
    </Card>
  )
}

export function Progress() {
  const { classId = '' } = useParams()
  const client = useQueryClient()
  const klass = useClass(classId)
  const today = useTodayGrid(classId)
  const homework = useClassHomework(classId)

  if (today.error) return <Notice tone="system-error">{messageFor(today.error)}</Notice>

  return (
    <>
      <PageHeader title={klass.data ? `${klass.data.name} — progress` : 'Progress'}>
        <Button
          variant="secondary"
          onClick={() =>
            void Promise.all(
              [['today-grid', classId], ['grid'], ['homework', classId]].map((queryKey) =>
                client.invalidateQueries({ queryKey }),
              ),
            )
          }
        >
          Refresh
        </Button>
      </PageHeader>

      <Card className="mb-6">
        <h2 className="mb-3 font-display font-semibold text-lg text-grape">
          Today{today.data?.title ? `: ${today.data.title}` : ''}
        </h2>
        {today.isPending ? <Spinner label="Loading" /> : null}
        {today.data && today.data.columns.length === 0 ? (
          <p className="text-sm text-muted">
            No ladder open today. Choose today’s lesson on the class page.
          </p>
        ) : null}
        {today.data && today.data.columns.length > 0 ? <Grid grid={today.data} showFinished /> : null}
      </Card>

      {(homework.data ?? [])
        .filter((hw) => hw.status !== 'draft')
        .map((hw) => (
          <HomeworkGrid key={hw.id} homework={hw} />
        ))}
    </>
  )
}
