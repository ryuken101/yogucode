/**
 * An ordered list of published problems — a lesson's ladder, or a homework sheet.
 *
 * Add from the published bank, reorder, remove, and swap an older version for a newer one
 * when the row offers it (a list keeps the version it was given until a teacher chooses;
 * see `app/classwork.py`). Controlled: the parent owns the rows and decides when to save.
 */

import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Dots } from '../components/Dots'
import { Select } from '../components/Field'
import { useProblems } from '../lib/queries'

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
  const addable = (published.data ?? []).filter((p) => !onList.has(p.id))

  function move(index: number, by: number) {
    const next = [...rows]
    const [row] = next.splice(index, 1)
    next.splice(index + by, 0, row!)
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <p className="text-sm text-ink-soft">{empty}</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {rows.map((row, index) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-2 rounded-lg bg-cream/60 px-3 py-2 ring-1 ring-ink/10"
            >
              <Dots value={row.difficulty} />
              <span className="text-ink">{row.title}</span>
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
        <Select
          label="Add a published problem"
          value=""
          disabled={rows.length >= limit}
          onChange={(event) => {
            const chosen = addable.find((p) => p.id === event.target.value)
            if (chosen) {
              onChange([
                ...rows,
                {
                  id: chosen.id,
                  title: chosen.title,
                  difficulty: chosen.difficulty,
                  newerVersionId: null,
                  superseded: false,
                },
              ])
            }
          }}
        >
          <option value="">Choose…</option>
          {addable.map((p) => (
            <option key={p.id} value={p.id}>
              {'●'.repeat(p.difficulty)} {p.title}
            </option>
          ))}
        </Select>
      )}
    </div>
  )
}
