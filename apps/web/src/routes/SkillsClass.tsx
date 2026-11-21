/**
 * A class's skills at a glance (Ken, 21 Nov 2026; the Skills app's Class tab).
 *
 * Children down the side, the tree's top-level concepts across; each cell is that concept's
 * whole branch for that child. A pale column is something to reteach the class; a row of
 * ⟲ is a child to help. The bottom row counts both per concept. Click a child, or a cell,
 * for their own tree. No ranking: rows are by name, or with those to revisit first.
 *
 * The revisit switches — slipping, stuck, gone stale — are the class's, any teacher may
 * change them, and every flag on these pages follows them.
 */

import { Settings2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { Button } from '../components/Button'
import { Card, EmptyState, PageHeader } from '../components/Card'
import { Dialog } from '../components/Dialog'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { messageFor } from '../lib/errors'
import { useClassSkills, useSkillSettings } from '../lib/queries'
import { FLAG_LABEL, describe, type Flag } from '../skills/levels'
import { Legend, LevelDot, RevisitMark } from '../skills/SkillMarks'

const FLAGS: Flag[] = ['slipping', 'stuck', 'stale']

function RevisitSettings({ classId, settings }: { classId: string; settings: Record<Flag, boolean> }) {
  const [open, setOpen] = useState(false)
  const save = useSkillSettings(classId)
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Settings2 className="mr-1.5 size-4" aria-hidden />
        Revisit signs
      </Button>
      <Dialog open={open} title="When should a concept be revisited?" onClose={() => setOpen(false)}>
        <p className="mb-3 text-sm">For this class. Turn off any sign you don’t want flagged.</p>
        <ul className="space-y-2">
          {FLAGS.map((flag) => (
            <li key={flag}>
              <label className="flex items-center gap-2 text-sm text-grape">
                <input
                  type="checkbox"
                  className="size-4 accent-grape"
                  checked={settings[flag]}
                  disabled={save.isPending}
                  onChange={(event) => save.mutate({ [flag]: event.target.checked })}
                />
                {FLAG_LABEL[flag]}
              </label>
            </li>
          ))}
        </ul>
        {save.isError ? (
          <div className="mt-3">
            <Notice tone="system-error">{messageFor(save.error)}</Notice>
          </div>
        ) : null}
      </Dialog>
    </>
  )
}

export function SkillsClass() {
  const { classId = '' } = useParams()
  const skills = useClassSkills(classId)
  const [revisitFirst, setRevisitFirst] = useState(false)

  if (skills.isPending) return <Spinner />
  if (skills.isError)
    return (
      <div className="p-6">
        <Notice tone="system-error">{messageFor(skills.error)}</Notice>
      </div>
    )

  const { columns, settings } = skills.data
  const needs = (cells: (typeof skills.data.rows)[number]['cells']) =>
    cells.filter((c) => c.revisit.length || c.below).length
  const rows = revisitFirst
    ? [...skills.data.rows].sort((a, b) => needs(b.cells) - needs(a.cells))
    : skills.data.rows

  return (
    <div>
      <PageHeader title="Skills">
        <label className="flex items-center gap-2 text-sm text-grape">
          <input
            type="checkbox"
            className="size-4 accent-grape"
            checked={revisitFirst}
            onChange={(event) => setRevisitFirst(event.target.checked)}
          />
          Revisit first
        </label>
        <RevisitSettings classId={classId} settings={settings} />
      </PageHeader>
      <div className="mb-4">
        <Legend />
      </div>

      {!rows.length ? (
        <EmptyState title="No children in this class yet" />
      ) : !columns.length ? (
        <EmptyState title="No concepts yet">
          Add them in the <Link to="/skills/tree">skill tree</Link>.
        </EmptyState>
      ) : (
        <Card className="!p-0 overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Each child’s level on each concept</caption>
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 bg-surface px-4 py-3 text-left font-medium text-grape">
                  Child
                </th>
                {columns.map((column) => (
                  <th
                    key={column.concept_id}
                    scope="col"
                    title={column.label}
                    className="max-w-24 px-2 py-3 text-center text-xs font-medium text-grape"
                  >
                    <span className="line-clamp-2">{column.label}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.student_id} className="hover:bg-cream/60">
                  <th scope="row" className="sticky left-0 border-t border-line bg-surface px-4 py-2 text-left font-normal">
                    <Link
                      to={`/classes/${classId}/skills/${row.student_id}`}
                      className="text-grape underline-offset-2 hover:underline"
                    >
                      {row.display_name}
                    </Link>
                  </th>
                  {row.cells.map((cell, i) => (
                    <td key={columns[i].concept_id} className="border-t border-line px-2 py-2 text-center">
                      <Link
                        to={`/classes/${classId}/skills/${row.student_id}?concept=${columns[i].concept_id}`}
                        aria-label={`${row.display_name}, ${columns[i].label}: ${describe(cell)}`}
                        title={describe(cell)}
                        className="inline-flex items-center gap-0.5 rounded-lg p-1 hover:bg-grape-pale"
                      >
                        <LevelDot skill={cell} />
                        <RevisitMark flags={cell.revisit} below={cell.below} />
                      </Link>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className="sticky left-0 border-t-2 border-line bg-surface px-4 py-2 text-left text-xs font-medium text-muted">
                  Secure · revisit
                </th>
                {columns.map((column, i) => {
                  const cells = skills.data.rows.map((r) => r.cells[i])
                  const secure = cells.filter((c) => c.level === 'secure').length
                  const revisit = cells.filter((c) => c.revisit.length || c.below).length
                  return (
                    <td
                      key={column.concept_id}
                      className="border-t-2 border-line px-2 py-2 text-center text-xs text-muted"
                      aria-label={`${column.label}: ${secure} secure, ${revisit} to revisit`}
                    >
                      {secure} · {revisit}
                    </td>
                  )
                })}
              </tr>
            </tfoot>
          </table>
        </Card>
      )}
    </div>
  )
}
