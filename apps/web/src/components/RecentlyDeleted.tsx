/**
 * A child's Trash, under their files (Ken's decision, 23 Oct 2026): what they deleted in the
 * last 30 days, to put back. There is no "delete for good" here — a child can't empty
 * their Trash, so a term's work is never one tap from gone.
 */

import { RotateCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { daysLeft } from '../lib/dates'
import { messageFor } from '../lib/errors'
import { useMyTrash, useRestoreMine } from '../lib/queries'
import { Notice } from './Notice'

export function RecentlyDeleted({ alwaysOpen = false }: { alwaysOpen?: boolean }) {
  const trash = useMyTrash()
  const restore = useRestoreMine()
  const [opened, setOpen] = useState(false)
  const open = alwaysOpen || opened
  const entries = trash.data ?? []
  if (entries.length === 0) {
    return alwaysOpen && trash.data ? <p className="text-sm text-muted">Nothing here.</p> : null
  }

  return (
    <section className="mt-3 rounded-2xl bg-cream/60 px-3 py-2 ring-1 ring-line">
      {/* On its own page the title is already there; this toggle is for under the explorer. */}
      {alwaysOpen ? null : (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-2 text-left text-sm font-medium text-grape"
        >
          <Trash2 size={14} aria-hidden="true" />
          Recently deleted ({entries.length})
        </button>
      )}
      {open ? (
        <ul className={`flex flex-col gap-1.5 ${alwaysOpen ? '' : 'mt-2'}`}>
          {entries.map((entry) => (
            <li key={`${entry.kind}-${entry.id}`} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 break-all text-grape">
                {entry.kind === 'folder' ? `${entry.name}/` : entry.name}
                <span className="block text-xs text-muted">
                  gone for good in {daysLeft(entry.purge_after)} days
                </span>
              </span>
              <button
                type="button"
                aria-label={`Put back ${entry.name}`}
                title="Put back"
                disabled={restore.isPending}
                onClick={() => restore.mutate({ kind: entry.kind as 'file' | 'folder', id: entry.id })}
                className="flex items-center gap-1 rounded-xl px-2 py-1 text-grape-deep hover:bg-grape-pale"
              >
                <RotateCcw size={13} aria-hidden="true" /> Put back
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {restore.error ? (
        <div className="mt-2">
          <Notice tone="not-yet">{messageFor(restore.error)}</Notice>
        </div>
      ) : null}
    </section>
  )
}
