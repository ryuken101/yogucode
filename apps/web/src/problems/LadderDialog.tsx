/**
 * A lesson's ladder: the problems a class climbs in that lesson (spec §3.3).
 *
 * Usually 1–2 one-dot problems on today's concept, a two-dot mixing in an earlier one, and
 * a three-dot extension — so nobody runs out of work. The order here is the order a child
 * sees. Only published problems can be added.
 *
 * A ladder keeps the exact version it was given. When a newer version of a problem is
 * published, the row says so and offers the swap; it never happens on its own, because
 * swapping mid-lesson would change a problem under a child who is halfway through it.
 */

import { useState } from 'react'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { Dots } from '../components/Dots'
import { Select } from '../components/Field'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import type { Schemas } from '../lib/api'
import { messageFor } from '../lib/errors'
import { useLadder, useProblems, useSaveLadder } from '../lib/queries'

interface Row {
  id: string
  title: string
  difficulty: number
  newerVersionId: string | null
  superseded: boolean
}

function fromLadder(item: Schemas['LadderItemOut']): Row {
  return {
    id: item.id,
    title: item.title,
    difficulty: item.difficulty,
    newerVersionId: item.newer_version_id,
    superseded: item.status !== 'published',
  }
}

export function LadderDialog({
  lesson,
  onClose,
}: {
  lesson: Schemas['LessonOut'] | null
  onClose: () => void
}) {
  const ladder = useLadder(lesson?.id ?? null)
  const published = useProblems({ statuses: ['published'] })
  const save = useSaveLadder(lesson?.id ?? '')
  // The teacher's edits, over the saved ladder. Null until they change something; the
  // parent keys this dialog by lesson, so each opening starts from what is saved.
  const [edited, setRows] = useState<Row[] | null>(null)
  const rows = edited ?? ladder.data?.map(fromLadder) ?? null

  function move(index: number, by: number) {
    if (!rows) return
    const next = [...rows]
    const [row] = next.splice(index, 1)
    next.splice(index + by, 0, row!)
    setRows(next)
  }

  const onLadder = new Set((rows ?? []).map((row) => row.id))
  const addable = (published.data ?? []).filter((p) => !onLadder.has(p.id))

  return (
    <Dialog
      open={lesson !== null}
      title={lesson ? `Ladder for “${lesson.title}”` : ''}
      onClose={onClose}
      confirm={{
        label: save.isPending ? 'Saving…' : 'Save ladder',
        disabled: !rows || save.isPending,
        onConfirm: () =>
          rows && save.mutate(rows.map((row) => row.id), { onSuccess: () => onClose() }),
      }}
    >
      {ladder.isPending || !rows ? <Spinner label="Loading ladder" /> : null}
      {rows ? (
        <div className="flex flex-col gap-3">
          {rows.length === 0 ? (
            <p className="text-ink-soft">
              No problems yet. Start with one or two 1-dot problems on this lesson’s concept.
            </p>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {rows.map((row, index) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg bg-cream/60 px-3 py-2 ring-1 ring-ink/10"
                >
                  <Dots value={row.difficulty} />
                  <span className="text-ink">{row.title}</span>
                  {row.newerVersionId ? (
                    <Button
                      variant="quiet"
                      onClick={() => {
                        const newer = published.data?.find((p) => p.id === row.newerVersionId)
                        setRows(
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
                    <Button variant="quiet" onClick={() => setRows(rows.filter((r) => r.id !== row.id))}>
                      Remove
                    </Button>
                  </span>
                </li>
              ))}
            </ol>
          )}
          <Select
            label="Add a published problem"
            value=""
            disabled={rows.length >= 12}
            onChange={(event) => {
              const chosen = addable.find((p) => p.id === event.target.value)
              if (chosen) {
                setRows([
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
          {save.error ? <Notice tone="not-yet">{messageFor(save.error)}</Notice> : null}
        </div>
      ) : null}
    </Dialog>
  )
}
