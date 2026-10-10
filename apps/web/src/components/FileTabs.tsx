/**
 * The student's files, as tabs.
 *
 * Tabs rather than a sidebar because the editor and terminal already split the screen
 * vertically on a laptop, and horizontal space is where Python lines want room. A term
 * produces a handful of files, not twenty, so a strip is enough.
 *
 * Since folders arrived (11 Oct 2026) these are only the files you have open, as in VS
 * Code: closing a tab just closes it, and the file stays in the explorer. Deleting is the
 * explorer's job.
 */

import { FileCode2, FileText, Plus, X } from 'lucide-react'
import { useState } from 'react'
import type { Schemas } from '../lib/api'
import { isPythonFile } from '../lib/fileType'

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
                ? 'bg-night text-cream'
                : 'bg-surface text-muted ring-1 ring-line hover:text-grape'
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
                className="w-28 rounded bg-surface px-1 text-grape ring-1 ring-grape outline-none"
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
                className="flex max-w-44 items-center gap-1.5 font-mono"
              >
                {isPythonFile(file.title) ? (
                  <FileCode2
                    size={14}
                    aria-hidden="true"
                    className={`shrink-0 ${active ? 'text-lavender' : 'text-muted'}`}
                  />
                ) : (
                  <FileText
                    size={14}
                    aria-hidden="true"
                    className={`shrink-0 ${active ? 'text-lavender' : 'text-muted'}`}
                  />
                )}
                <span className="truncate">{file.title}</span>
              </button>
            )}
            {files.length > 0 ? (
              <button
                type="button"
                onClick={() => onClose(file.id)}
                aria-label={`Close ${file.title}`}
                title="Close tab"
                className={`rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 ${
                  active ? 'text-cream/60 hover:text-cream' : 'text-muted hover:text-grape'
                }`}
              >
                <X size={14} aria-hidden="true" />
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
        className="rounded-t-lg bg-surface px-2.5 py-1.5 text-sm text-muted ring-1 ring-line hover:text-grape disabled:opacity-50"
      >
        <Plus size={16} aria-hidden="true" />
      </button>
    </div>
  )
}
