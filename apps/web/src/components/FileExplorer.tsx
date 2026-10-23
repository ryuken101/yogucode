/**
 * The file explorer — folders and files, VS Code style (Ken's decisions, 11 Oct 2026).
 *
 * Used by a child's My files and a teacher's My code. Folders nest; the chevron opens and
 * closes them; clicking a file opens it in a tab. New file and New folder go into the
 * selected folder (the one last clicked, or the open file's). Each row has rename, move and
 * delete actions on hover or focus; double-click or F2 also renames.
 *
 * **Moving** works the way VS Code does:
 * - drop on a folder → into that folder;
 * - drop on a file → into the folder that file is in;
 * - drop on empty space in the list → out to the top level.
 * The whole list is a drop target for the top level, because "drag it out of the folder
 * and let go" was what people tried first and the old heading-only target didn't catch it.
 * **Move to…** does the same from a menu, for keyboards and fiddly trackpads.
 *
 * Deleting archives — a child's work is never destroyed by tidying up — but the words
 * here still say "delete", because that is what it is to the person doing it. No red: the
 * bin icon is the same quiet colour as the others (the palette rule).
 */

import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FilePlus2,
  FileText,
  Folder as FolderIcon,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Schemas } from '../lib/api'
import { isPythonFile } from '../lib/fileType'
import { canMove, pathOf, subtree } from '../lib/folderTree'
import { Dialog } from './Dialog'
import { Select } from './Field'

type File = Schemas['DocumentSummaryOut']
type Folder = Schemas['FolderOut']
type Item = { kind: 'file' | 'folder'; id: string }

const DRAG_TYPE = 'application/x-yogucode-item'
const TOP = '__top__'
const ICON = { size: 16, strokeWidth: 2, 'aria-hidden': true } as const

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
  restoreNote = 'It goes to Recently deleted for 30 days, where you can put it back.',
}: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<Item | null>(null)
  const [draft, setDraft] = useState('')
  const [newFolderIn, setNewFolderIn] = useState<string | null | undefined>(undefined)
  const [folderName, setFolderName] = useState('')
  const [confirm, setConfirm] = useState<(Item & { name: string }) | null>(null)
  const [moving, setMoving] = useState<(Item & { name: string }) | null>(null)
  const [moveTarget, setMoveTarget] = useState(TOP)
  // undefined: not dragging over anything; null: the top level; a string: that folder.
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined)
  const [dragging, setDragging] = useState(false)

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

  /** Move, unless it would change nothing or put a folder inside itself. */
  function moveTo(item: Item, folderId: string | null) {
    if (!canMove(item, folderId, files, folders)) return
    onMove(item, folderId)
    if (folderId) setOpen((current) => new Set(current).add(folderId))
  }

  function dragProps(item: Item) {
    return {
      draggable: true,
      onDragStart: (event: React.DragEvent) => {
        event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item))
        event.dataTransfer.effectAllowed = 'move'
        setDragging(true)
      },
      onDragEnd: () => {
        setDragging(false)
        setDropTarget(undefined)
      },
    }
  }

  /** Accept a drop meaning "into `folderId`" (null: the top level). */
  function dropProps(folderId: string | null) {
    return {
      onDragOver: (event: React.DragEvent) => {
        if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
        event.preventDefault()
        // The innermost target decides: a folder row inside the list wins over the list.
        event.stopPropagation()
        setDropTarget(folderId)
      },
      onDrop: (event: React.DragEvent) => {
        event.preventDefault()
        event.stopPropagation()
        setDropTarget(undefined)
        setDragging(false)
        const raw = event.dataTransfer.getData(DRAG_TYPE)
        if (raw) moveTo(JSON.parse(raw) as Item, folderId)
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

  function actions(item: Item, name: string) {
    const button =
      'rounded p-0.5 text-muted hover:bg-grape-pale hover:text-grape focus-visible:outline-2 focus-visible:outline-grape'
    return (
      <span className="flex shrink-0 items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          // Not "Rename …": that is the rename box's own label, here and on the tab.
          aria-label={`Edit name of ${name}`}
          title="Rename"
          className={button}
          onClick={(event) => {
            event.stopPropagation()
            startRename(item, name)
          }}
        >
          <Pencil {...ICON} size={14} />
        </button>
        <button
          type="button"
          aria-label={`Move ${name}`}
          title="Move to…"
          className={button}
          onClick={(event) => {
            event.stopPropagation()
            const current =
              item.kind === 'file'
                ? files.find((f) => f.id === item.id)?.folder_id
                : folders.find((f) => f.id === item.id)?.parent_id
            setMoveTarget(current ?? TOP)
            setMoving({ ...item, name })
          }}
        >
          <FolderInput {...ICON} size={14} />
        </button>
        <button
          type="button"
          aria-label={`Delete ${name}`}
          title="Delete"
          className={button}
          onClick={(event) => {
            event.stopPropagation()
            setConfirm({ ...item, name })
          }}
        >
          <Trash2 {...ICON} size={14} />
        </button>
      </span>
    )
  }

  function newFolderRow(depth: number) {
    return (
      <li style={{ paddingLeft: depth * 14 + 4 }} className="flex items-center gap-1 py-0.5">
        <FolderIcon {...ICON} className="shrink-0 text-not-yet-ink" />
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
          className="min-w-0 flex-1 rounded bg-surface px-1 text-sm text-grape ring-1 ring-grape outline-none"
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
          const editing = renaming?.kind === 'folder' && renaming.id === folder.id
          return (
            <li key={folder.id} role="treeitem" aria-expanded={isOpen} aria-selected={false}>
              <div
                {...dragProps(item)}
                {...dropProps(folder.id)}
                style={{ paddingLeft: depth * 14 }}
                className={`group flex items-center gap-1 rounded-lg py-0.5 pr-1 ${
                  dropTarget === folder.id
                    ? 'bg-grape-pale ring-1 ring-grape'
                    : selected === folder.id
                      ? 'bg-cream'
                      : 'hover:bg-cream'
                }`}
              >
                {editing ? (
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
                    {isOpen ? (
                      <ChevronDown {...ICON} size={14} className="shrink-0 text-muted" />
                    ) : (
                      <ChevronRight {...ICON} size={14} className="shrink-0 text-muted" />
                    )}
                    {isOpen ? (
                      <FolderOpen {...ICON} className="shrink-0 text-not-yet-ink" />
                    ) : (
                      <FolderIcon {...ICON} className="shrink-0 text-not-yet-ink" />
                    )}
                    <span className="truncate font-medium">{folder.name}</span>
                  </button>
                )}
                {editing ? null : actions(item, folder.name)}
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
          const editing = renaming?.kind === 'file' && renaming.id === file.id
          return (
            <li key={file.id} role="treeitem" aria-selected={active}>
              <div
                {...dragProps(item)}
                // Dropping on a file means "into the folder this file is in".
                {...dropProps(file.folder_id ?? null)}
                style={{ paddingLeft: depth * 14 + 15 }}
                className={`group flex items-center gap-1 rounded-lg py-0.5 pr-1 ${
                  active ? 'bg-grape-pale' : 'hover:bg-cream'
                }`}
              >
                {isPythonFile(file.title) ? (
                  <FileCode2 {...ICON} className="shrink-0 text-muted" />
                ) : (
                  <FileText {...ICON} className="shrink-0 text-muted/70" />
                )}
                {editing ? (
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
                    className={`min-w-0 flex-1 truncate text-left font-mono text-sm text-grape ${
                      active ? 'font-medium' : ''
                    }`}
                  >
                    {file.title}
                  </button>
                )}
                {editing ? null : actions(item, file.title)}
              </div>
            </li>
          )
        })}
      </>
    )
  }

  const movingOptions =
    moving === null
      ? []
      : folders
          .filter((f) => moving.kind === 'file' || !subtree(folders, moving.id).has(f.id))
          .map((f) => ({ id: f.id, label: pathOf(folders, f.id) }))
          .sort((a, b) => a.label.localeCompare(b.label))

  const iconButton =
    'rounded-lg p-1 text-muted hover:bg-cream hover:text-grape focus-visible:outline-2 focus-visible:outline-grape disabled:opacity-50'

  return (
    <nav
      aria-label="Files"
      className={`flex h-full min-h-0 flex-col rounded-2xl bg-surface p-2 ring-1 ${
        dragging && dropTarget === null ? 'ring-2 ring-dashed ring-grape' : 'ring-line'
      }`}
    >
      <div {...dropProps(null)} className="mb-1 flex items-center gap-1 px-1">
        <span className="flex-1 text-xs font-semibold tracking-wide text-muted uppercase">
          Files
        </span>
        <button
          type="button"
          onClick={() => onCreateFile(target)}
          disabled={busy}
          aria-label="New file"
          title="New file"
          className={iconButton}
        >
          <FilePlus2 {...ICON} />
        </button>
        <button
          type="button"
          onClick={() => {
            setNewFolderIn(target)
            if (target) setOpen((current) => new Set(current).add(target))
          }}
          aria-label="New folder"
          title="New folder"
          className={iconButton}
        >
          <FolderPlus {...ICON} />
        </button>
      </div>
      {/* The whole list is a drop target for the top level: let go anywhere that is not a
          folder or a file in a folder, and the item comes out to the top. */}
      <ul
        role="tree"
        aria-label="Your files and folders"
        {...dropProps(null)}
        className="min-h-0 flex-1 overflow-y-auto pb-6"
      >
        {newFolderIn === null ? newFolderRow(0) : null}
        {branch(null, 0)}
        {files.length === 0 && folders.length === 0 ? (
          <li className="px-2 py-1 text-sm text-muted">No files yet.</li>
        ) : null}
      </ul>
      {dragging ? (
        <p className="px-2 pt-1 text-xs text-muted" aria-live="polite">
          Drop on a folder to move it there, or on empty space to move it out.
        </p>
      ) : null}

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

      <Dialog
        open={moving !== null}
        title={moving ? `Move ${moving.name}` : ''}
        onClose={() => setMoving(null)}
        confirm={{
          label: 'Move',
          onConfirm: () => {
            if (!moving) return
            moveTo({ kind: moving.kind, id: moving.id }, moveTarget === TOP ? null : moveTarget)
            setMoving(null)
          },
        }}
      >
        <Select
          label="Move to"
          value={moveTarget}
          onChange={(event) => setMoveTarget(event.target.value)}
        >
          <option value={TOP}>Top level (no folder)</option>
          {movingOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </Select>
      </Dialog>
    </nav>
  )
}
