/**
 * An ordered list of published problems — a lesson's ladder, or a homework sheet.
 *
 * Add from the published bank (`ProblemPicker`), reorder, remove, and swap an older version for a newer one
 * when the row offers it (a list keeps the version it was given until a teacher chooses;
 * see `app/classwork.py`). Controlled: the parent owns the rows and decides when to save.
 */

import { useState } from 'react'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Dots } from '../components/Dots'
import { useProblems } from '../lib/queries'
import { ProblemPicker } from './ProblemPicker'

export interface ProblemRow {
  id: string
  title: string
  difficulty: number
  newerVersionId: string | null
  superseded: boolean
}

interface Props {
  rows: ProblemRow[]
  onChange: (rows: ProblemRow[]) => void
  empty: string
  limit?: number
  disabled?: boolean
}

export function ProblemListEditor({ rows, onChange, empty, limit = 12, disabled = false }: Props) {
  const published = useProblems({ statuses: ['published'] })
  const onList = new Set(rows.map((row) => row.id))
  const [picking, setPicking] = useState(false)

  function move(index: number, by: number) {
    const next = [...rows]
    const [row] = next.splice(index, 1)
    next.splice(index + by, 0, row!)
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{empty}</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {rows.map((row, index) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-2 rounded-lg bg-cream/60 px-3 py-2 ring-1 ring-line"
            >
              <Dots value={row.difficulty} />
              <span className="text-grape">{row.title}</span>
              {row.newerVersionId && !disabled ? (
                <Button
                  variant="quiet"
                  onClick={() => {
                    const newer = published.data?.find((p) => p.id === row.newerVersionId)
                    onChange(
                      rows.map((r) =>
                        r.id === row.id
                          ? {
                              id: row.newerVersionId!,
                              title: newer?.title ?? row.title,
                              difficulty: newer?.difficulty ?? row.difficulty,
                              newerVersionId: null,
                              superseded: false,
                            }
                          : r,
                      ),
                    )
                  }}
                >
                  Use the newer version
                </Button>
              ) : row.superseded ? (
                <Badge variant="muted">older version</Badge>
              ) : null}
              {disabled ? null : (
                <span className="ml-auto flex">
                  <Button variant="quiet" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>
                    ↑
                  </Button>
                  <Button
                    variant="quiet"
                    aria-label="Move down"
                    disabled={index === rows.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </Button>
                  <Button variant="quiet" onClick={() => onChange(rows.filter((r) => r.id !== row.id))}>
                    Remove
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {disabled ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" disabled={rows.length >= limit} onClick={() => setPicking(true)}>
            Add problems
          </Button>
          {rows.length >= limit ? (
            <span className="text-sm text-muted">This list is full ({limit} at most).</span>
          ) : null}
        </div>
      )}
      {picking ? (
        <ProblemPicker
          onList={onList}
          limit={limit}
          onClose={() => setPicking(false)}
          onAdd={(chosen) => {
            setPicking(false)
            onChange([
              ...rows,
              ...chosen.map((p) => ({
                id: p.id,
                title: p.title,
                difficulty: p.difficulty,
                newerVersionId: null,
                superseded: false,
              })),
            ])
          }}
        />
      ) : null}
    </div>
  )
}
