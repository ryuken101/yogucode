/**
 * The Trash, for teachers (Ken's decision, 23 Oct 2026): everything deleted at the centre
 * that this teacher can see, newest first, with how long until it goes for good.
 *
 * Restore is open to any teacher. Delete for good follows the server's rules
 * (`apps/api/src/app/trash.py`): a class or a child, the owner only, with the name typed;
 * anything else, the owner or whoever deleted or made it. A folder, unit or course stands
 * for everything that went with it.
 */

import { useState } from 'react'
import { Button } from '../components/Button'
import { Card, PageHeader } from '../components/Card'
import { Dialog } from '../components/Dialog'
import { TextInput } from '../components/Field'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import type { Schemas } from '../lib/api'
import { daysLeft } from '../lib/dates'
import { messageFor } from '../lib/errors'
import { useTrash, useTrashAction } from '../lib/queries'

type Entry = Schemas['TrashEntryOut']

const KIND: Record<Entry['kind'], string> = {
  class: 'Class',
  student: 'Student',
  problem: 'Problem',
  course: 'Course',
  unit: 'Unit',
  lesson: 'Lesson',
  homework: 'Homework',
  file: 'File',
  folder: 'Folder',
}

export function Trash() {
  const trash = useTrash()
  const act = useTrashAction()
  const [purging, setPurging] = useState<Entry | null>(null)

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <PageHeader title="Trash" />
      <p className="-mt-3 mb-6 text-sm text-muted">
        Deleted things wait here for 30 days, then they are deleted for good.
      </p>
      {trash.isPending ? <Spinner label="Opening the Trash" /> : null}
      {trash.error ? <Notice tone="system-error">{messageFor(trash.error)}</Notice> : null}
      {act.error && !purging ? <Notice tone="not-yet">{messageFor(act.error)}</Notice> : null}
      {trash.data && trash.data.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">Nothing in the Trash.</p>
        </Card>
      ) : null}
      {trash.data && trash.data.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {trash.data.map((entry) => {
            const days = daysLeft(entry.purge_after)
            return (
              <li
                key={`${entry.kind}-${entry.id}`}
                className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface px-4 py-3 ring-1 ring-line"
              >
                <span className="rounded-full bg-cream px-2.5 py-0.5 text-xs font-medium text-muted ring-1 ring-line">
                  {KIND[entry.kind]}
                </span>
                <span className="min-w-0 font-medium break-words text-grape">{entry.name}</span>
                {entry.detail ? <span className="text-sm text-muted">{entry.detail}</span> : null}
                <span className="text-sm text-muted">
                  {entry.deleted_by ? `Deleted by ${entry.deleted_by} · ` : ''}
                  {days === 1 ? '1 day left' : `${days} days left`}
                </span>
                <span className="ml-auto flex gap-1">
                  <Button
                    variant="secondary"
                    disabled={act.isPending}
                    onClick={() => act.mutate({ action: 'restore', kind: entry.kind, id: entry.id })}
                  >
                    Restore
                  </Button>
                  {entry.can_purge ? (
                    <Button variant="quiet" onClick={() => setPurging(entry)}>
                      Delete for good…
                    </Button>
                  ) : null}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
      {purging ? (
        <PurgeDialog
          key={purging.id}
          entry={purging}
          busy={act.isPending}
          error={act.error ? messageFor(act.error) : null}
          onClose={() => {
            act.reset()
            setPurging(null)
          }}
          onConfirm={(confirmName) =>
            act.mutate(
              { action: 'purge', kind: purging.kind, id: purging.id, confirmName },
              { onSuccess: () => setPurging(null) },
            )
          }
        />
      ) : null}
    </div>
  )
}

const same = (a: string, b: string) =>
  a.split(/\s+/).join(' ').trim().toLowerCase() === b.split(/\s+/).join(' ').trim().toLowerCase()

function PurgeDialog({
  entry,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  entry: Entry
  busy: boolean
  error: string | null
  onClose: () => void
  onConfirm: (confirmName?: string) => void
}) {
  const [typed, setTyped] = useState('')
  return (
    <Dialog
      open
      title={`Delete ${entry.name} for good?`}
      onClose={onClose}
      confirm={{
        label: 'Delete for good',
        disabled: busy || (entry.needs_name && !same(typed, entry.name)),
        onConfirm: () => onConfirm(entry.needs_name ? typed : undefined),
      }}
    >
      <p>
        {entry.kind === 'class'
          ? 'The class goes with all its homework, quizzes, handed-in work and marks. Its students’ accounts and files stay.'
          : entry.kind === 'student'
            ? 'Their account goes with everything they made, in every class.'
            : entry.kind === 'homework'
              ? 'Every child’s answers and marks on it go too.'
              : 'Everything that went to the Trash with it goes too.'}
      </p>
      <p className="mt-2 font-medium">This can’t be undone.</p>
      {entry.needs_name ? (
        <div className="mt-4">
          <TextInput
            label={`Type ${entry.name} to confirm`}
            value={typed}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
      ) : null}
      {error ? (
        <div className="mt-3">
          <Notice tone="not-yet">{error}</Notice>
        </div>
      ) : null}
    </Dialog>
  )
}
