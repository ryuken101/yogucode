/**
 * The student's files, as tabs.
 *
 * Tabs rather than a sidebar because the editor and terminal already split the screen
 * vertically on a laptop, and horizontal space is where Python lines want room. A term
 * produces a handful of files, not twenty, so a strip is enough.
 *
 * Closing a tab **archives** the file; it does not delete it. Nothing in this product is
 * deleted, and a child tidying up mid-term must not be able to lose a term of their own
 * work in one tap. The word is "Close" rather than "Delete" for the same reason.
 */

import { useState } from 'react'
import type { Schemas } from '../lib/api'

interface Props {
  files: Schemas['DocumentSummaryOut'][]
  activeId: string | null
  onSelect: (documentId: string) => void
  onCreate: () => void
  onClose: (documentId: string) => void
  onRename: (documentId: string, title: string) => void
  busy?: boolean
}

export function FileTabs({
  files,
  activeId,
  onSelect,
  onCreate,
  onClose,
  onRename,
  busy = false,
}: Props) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  function startRename(file: Schemas['DocumentSummaryOut']) {
    setRenaming(file.id)
    setDraft(file.title)
  }

  function commitRename() {
    const id = renaming
    setRenaming(null)
    if (id && draft.trim() && draft.trim() !== files.find((f) => f.id === id)?.title) {
      onRename(id, draft.trim())
    }
  }

  return (
    <div role="tablist" aria-label="Your files" className="flex shrink-0 items-end gap-1">
      {files.map((file) => {
        const active = file.id === activeId
        return (
          <div
            key={file.id}
            className={`group flex items-center gap-1 rounded-t-lg px-3 py-1.5 text-sm ${
              active
                ? 'bg-ink-deep text-cream'
                : 'bg-paper text-ink-soft ring-1 ring-ink/10 hover:text-ink'
            }`}
          >
            {renaming === file.id ? (
              <input
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitRename()
                  if (event.key === 'Escape') setRenaming(null)
                }}
                aria-label={`Rename ${file.title}`}
                className="w-28 rounded bg-paper px-1 text-ink ring-1 ring-sky outline-none"
              />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSelect(file.id)}
                // A second click on the file you are already in renames it, which is where
                // a child looks for that rather than in a menu.
                onDoubleClick={() => active && startRename(file)}
                className="max-w-40 truncate font-mono"
              >
                {file.title}
              </button>
            )}
            {files.length > 1 ? (
              <button
                type="button"
                onClick={() => onClose(file.id)}
                aria-label={`Close ${file.title}`}
                title="Close this file (you can get it back)"
                className={`rounded px-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 ${
                  active ? 'text-cream/60 hover:text-cream' : 'text-ink-soft hover:text-ink'
                }`}
              >
                ×
              </button>
            ) : null}
          </div>
        )
      })}

      <button
        type="button"
        onClick={onCreate}
        disabled={busy}
        aria-label="New file"
        title="New file"
        className="rounded-t-lg bg-paper px-3 py-1.5 text-sm text-ink-soft ring-1 ring-ink/10 hover:text-ink disabled:opacity-50"
      >
        +
      </button>
    </div>
  )
}
