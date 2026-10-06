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
import { Dialog } from '../components/Dialog'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import type { Schemas } from '../lib/api'
import { messageFor } from '../lib/errors'
import { useLadder, useSaveLadder } from '../lib/queries'
import { ProblemListEditor, type ProblemRow } from './ProblemListEditor'

type Row = ProblemRow

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
  const save = useSaveLadder(lesson?.id ?? '')
  // The teacher's edits, over the saved ladder. Null until they change something; the
  // parent keys this dialog by lesson, so each opening starts from what is saved.
  const [edited, setRows] = useState<Row[] | null>(null)
  const rows = edited ?? ladder.data?.map(fromLadder) ?? null


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
          <ProblemListEditor
            rows={rows}
            onChange={setRows}
            empty="No problems yet. Start with one or two 1-dot problems on this lesson’s concept."
          />
          {save.error ? <Notice tone="not-yet">{messageFor(save.error)}</Notice> : null}
        </div>
      ) : null}
    </Dialog>
  )
}
