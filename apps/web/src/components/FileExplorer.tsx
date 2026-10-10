/**
 * The file explorer — folders and files, VS Code style (Ken's decision, 11 Oct 2026).
 *
 * Used by a child's My files and a teacher's My code. Folders nest; ▸/▾ opens and closes
 * them; clicking a file opens it in a tab. New file and New folder go into the selected
 * folder (the one last clicked, or the open file's). Rename by double-clicking or F2;
 * delete with the × that appears on hover or focus, after a confirmation. Drag a file or
 * folder onto a folder to move it, or onto "Files" at the top to bring it to the top level.
 *
 * Deleting archives — a child's work is never destroyed by tidying up — but the words
 * here still say "delete", because that is what it is to the person doing it.
 */

import { useMemo, useState } from 'react'
import type { Schemas } from '../lib/api'
import { Dialog } from './Dialog'

type File = Schemas['DocumentSummaryOut']
type Folder = Schemas['FolderOut']
type Item = { kind: 'file' | 'folder'; id: string }

const DRAG_TYPE = 'application/x-yogucode-item'

interface Props {
  files: File[]
  folders: Folder[]
  activeId: string | null
  onOpen: (fileId: string) => void
  onCreateFile: (folderId: string | null) => void
  onCreateFolder: (name: string, parentId: string | null) => void
  onRenameFile: (fileId: string, title: string) => void
  onRenameFolder: (folderId: string, name: string) => void
  onMove: (item: Item, folderId: string | null) => void
  onDeleteFile: (fileId: string) => void
  onDeleteFolder: (folderId: string) => void
  busy?: boolean
  /** Said after "will be removed" in the delete confirmation. */
  restoreNote?: string
}

export function FileExplorer({
  files,
  folders,
  activeId,
  onOpen,
  onCreateFile,
  onCreateFolder,
  onRenameFile,
  onRenameFolder,
  onMove,
  onDeleteFile,
  onDeleteFolder,
  busy = false,
  restoreNote = 'Ask your teacher if you need them back.',
}: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<Item | null>(null)
  const [draft, setDraft] = useState('')
  const [newFolderIn, setNewFolderIn] = useState<string | null | undefined>(undefined)
  const [folderName, setFolderName] = useState('')
  const [confirm, setConfirm] = useState<(Item & { name: string }) | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined)

  const byParent = useMemo(() => {
    const map = new Map<string | null, Folder[]>()
    for (const f of folders) {
      const list = map.get(f.parent_id ?? null) ?? []
      list.push(f)
      map.set(f.parent_id ?? null, list)
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name))
    return map
  }, [folders])

  const filesIn = useMemo(() => {
    const map = new Map<string | null, File[]>()
    for (const f of files) {
      const list = map.get(f.folder_id ?? null) ?? []
      list.push(f)
      map.set(f.folder_id ?? null, list)
    }
    for (const list of map.values()) list.sort((a, b) => a.title.localeCompare(b.title))
    return map
  }, [files])

  const activeFolder = files.find((f) => f.id === activeId)?.folder_id ?? null
  // Where new things go: the folder last clicked, else the open file's folder.
  const target = selected !== null && folders.some((f) => f.id === selected) ? selected : activeFolder

  // A file's folder (and its parents) are open, so the file you are in is always visible.
  const shownOpen = useMemo(() => {
    const ids = new Set(open)
    let at = activeFolder
    while (at) {
      ids.add(at)
      at = folders.find((f) => f.id === at)?.parent_id ?? null
    }
    return ids
  }, [open, activeFolder, folders])

  function toggle(id: string) {
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function startRename(item: Item, name: string) {
    setRenaming(item)
    setDraft(name)
  }

  function commitRename() {
    const item = renaming
    setRenaming(null)
    const name = draft.trim()
    if (!item || !name) return
    if (item.kind === 'file') onRenameFile(item.id, name)
    else onRenameFolder(item.id, name)
  }

  function commitNewFolder() {
    const name = folderName.trim()
    const parent = newFolderIn
    setNewFolderIn(undefined)
    setFolderName('')
    if (name && parent !== undefined) {
      onCreateFolder(name, parent)
      if (parent) setOpen((current) => new Set(current).add(parent))
    }
  }

  function dragProps(item: Item) {
    return {
      draggable: true,
      onDragStart: (event: React.DragEvent) => {
        event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item))
        event.dataTransfer.effectAllowed = 'move'
      },
    }
  }

  function dropProps(folderId: string | null) {
    return {
      onDragOver: (event: React.DragEvent) => {
        if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
        event.preventDefault()
        setDropTarget(folderId)
      },
      onDragLeave: () => setDropTarget(undefined),
      onDrop: (event: React.DragEvent) => {
        event.preventDefault()
        setDropTarget(undefined)
        const raw = event.dataTransfer.getData(DRAG_TYPE)
        if (!raw) return
        const item = JSON.parse(raw) as Item
        if (item.kind === 'folder' && item.id === folderId) return
        onMove(item, folderId)
        if (folderId) setOpen((current) => new Set(current).add(folderId))
      },
    }
  }

  function renameBox(label: string) {
    return (
      <input
        autoFocus
        value={draft}
        aria-label={`Rename ${label}`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitRename}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commitRename()
          if (event.key === 'Escape') setRenaming(null)
        }}
        className="min-w-0 flex-1 rounded bg-surface px-1 text-sm text-grape ring-1 ring-grape outline-none"
      />
    )
  }

  function deleteButton(item: Item, name: string) {
    return (
      <button
        type="button"
        aria-label={`Delete ${name}`}
        title="Delete"
        onClick={(event) => {
          event.stopPropagation()
          setConfirm({ ...item, name })
        }}
        className="rounded px-1 text-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-grape"
      >
        ×
      </button>
    )
  }

  function newFolderRow(depth: number) {
    return (
      <li style={{ paddingLeft: depth * 14 }} className="py-0.5">
        <input
          autoFocus
          value={folderName}
          aria-label="New folder name"
          placeholder="Folder name"
          onChange={(event) => setFolderName(event.target.value)}
          onBlur={commitNewFolder}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitNewFolder()
            if (event.key === 'Escape') {
              setNewFolderIn(undefined)
              setFolderName('')
            }
          }}
          className="w-full rounded bg-surface px-1 text-sm text-grape ring-1 ring-grape outline-none"
        />
      </li>
    )
  }

  function branch(parentId: string | null, depth: number): React.ReactNode {
    return (
      <>
        {(byParent.get(parentId) ?? []).map((folder) => {
          const isOpen = shownOpen.has(folder.id)
          const item: Item = { kind: 'folder', id: folder.id }
          return (
            <li key={folder.id} role="treeitem" aria-expanded={isOpen} aria-selected={false}>
              <div
                {...dragProps(item)}
                {...dropProps(folder.id)}
                style={{ paddingLeft: depth * 14 }}
                className={`group flex items-center gap-1 rounded-lg py-0.5 pr-1 ${
                  dropTarget === folder.id ? 'bg-grape-pale ring-1 ring-grape' : ''
                } ${selected === folder.id ? 'bg-cream' : ''}`}
              >
                {renaming?.kind === 'folder' && renaming.id === folder.id ? (
                  renameBox(folder.name)
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      toggle(folder.id)
                      setSelected(folder.id)
                    }}
                    onDoubleClick={() => startRename(item, folder.name)}
                    onKeyDown={(event) => {
                      if (event.key === 'F2') startRename(item, folder.name)
                    }}
                    className="flex min-w-0 flex-1 items-center gap-1 text-left text-sm text-grape"
                  >
                    <span aria-hidden="true" className="w-3 text-muted">
                      {isOpen ? '▾' : '▸'}
                    </span>
                    <span className="truncate font-medium">{folder.name}</span>
                  </button>
                )}
                {deleteButton(item, folder.name)}
              </div>
              {isOpen ? (
                <ul role="group">
                  {newFolderIn === folder.id ? newFolderRow(depth + 1) : null}
                  {branch(folder.id, depth + 1)}
                </ul>
              ) : null}
            </li>
          )
        })}
        {(filesIn.get(parentId) ?? []).map((file) => {
          const item: Item = { kind: 'file', id: file.id }
          const active = file.id === activeId
          return (
            <li key={file.id} role="treeitem" aria-selected={active}>
              <div
                {...dragProps(item)}
                style={{ paddingLeft: depth * 14 + 16 }}
                className={`group flex items-center gap-1 rounded-lg py-0.5 pr-1 ${
                  active ? 'bg-grape-pale' : 'hover:bg-cream'
                }`}
              >
                {renaming?.kind === 'file' && renaming.id === file.id ? (
                  renameBox(file.title)
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      onOpen(file.id)
                      setSelected(null)
                    }}
                    onDoubleClick={() => startRename(item, file.title)}
                    onKeyDown={(event) => {
                      if (event.key === 'F2') startRename(item, file.title)
                    }}
                    className={`min-w-0 flex-1 truncate text-left font-mono text-sm ${
                      active ? 'font-medium text-grape' : 'text-grape'
                    }`}
                  >
                    {file.title}
                  </button>
                )}
                {deleteButton(item, file.title)}
              </div>
            </li>
          )
        })}
      </>
    )
  }

  return (
    <nav aria-label="Files" className="flex h-full min-h-0 flex-col rounded-2xl bg-surface p-2 ring-1 ring-line">
      <div
        {...dropProps(null)}
        className={`mb-1 flex items-center gap-1 rounded-lg px-1 ${
          dropTarget === null ? 'bg-grape-pale ring-1 ring-grape' : ''
        }`}
      >
        <span className="flex-1 text-xs font-semibold tracking-wide text-muted uppercase">
          Files
        </span>
        <button
          type="button"
          onClick={() => onCreateFile(target)}
          disabled={busy}
          aria-label="New file"
          title="New file"
          className="rounded px-1.5 text-sm text-muted hover:bg-cream hover:text-grape disabled:opacity-50"
        >
          + File
        </button>
        <button
          type="button"
          onClick={() => {
            setNewFolderIn(target)
            if (target) setOpen((current) => new Set(current).add(target))
          }}
          aria-label="New folder"
          title="New folder"
          className="rounded px-1.5 text-sm text-muted hover:bg-cream hover:text-grape"
        >
          + Folder
        </button>
      </div>
      <ul role="tree" aria-label="Your files and folders" className="min-h-0 flex-1 overflow-y-auto">
        {newFolderIn === null ? newFolderRow(0) : null}
        {branch(null, 0)}
        {files.length === 0 && folders.length === 0 ? (
          <li className="px-2 py-1 text-sm text-muted">No files yet.</li>
        ) : null}
      </ul>

      <Dialog
        open={confirm !== null}
        title={confirm ? `Delete ${confirm.name}?` : ''}
        onClose={() => setConfirm(null)}
        confirm={{
          label: 'Delete',
          onConfirm: () => {
            if (!confirm) return
            if (confirm.kind === 'file') onDeleteFile(confirm.id)
            else onDeleteFolder(confirm.id)
            setConfirm(null)
          },
        }}
      >
        {confirm?.kind === 'folder'
          ? `The folder, everything inside it, and the files in it will be removed. ${restoreNote}`
          : `The file will be removed. ${restoreNote}`}
      </Dialog>
    </nav>
  )
}
