/**
 * The Files app, in the style of the macOS Finder (Ken's decision, 16 Oct 2026).
 *
 * A sidebar of places, a toolbar (back, the folder path, Open, icon or list view), and the
 * folder's contents as real folder and file icons. One click selects, a double-click (or
 * Enter) opens: a folder opens in place, a file opens in Code.
 *
 * - A teacher's places are the children in the class chosen in the top bar, and their own
 *   My code. Opening a child's file shows it in Code as "Watching" — changing what it says
 *   goes through Live's Help — but the teacher may organise a child's files here.
 * - A child's places are Recents and My work — their own files, which open in their editor.
 *
 * The folder being looked at is in the URL (`?folder=`), so Back and a reload keep it.
 *
 * **Organising, as in Finder or File Explorer** (Ken, 17 Oct 2026): right-click for New
 * folder, New file, Rename, Duplicate, Cut, Copy, Paste, Move to… and Delete; drag onto a
 * folder or a crumb in the path to move; F2, Delete, ⌘C/⌘X/⌘V, ⌘D and ⌘⇧N from the keys.
 * New things are named in place. Every place does the same through `fileStore.ts`, and
 * Paste can cross places — a teacher copies a file from My code into a child's folder.
 * Delete archives, as everywhere. No red: a refused name is not-yet.
 */

import { useQueryClient } from '@tanstack/react-query'
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  FilePlus2,
  Folder,
  FolderPlus,
  LayoutGrid,
  List,
  User,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { Dialog } from '../components/Dialog'
import { Select } from '../components/Field'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import type { Schemas } from '../lib/api'
import { messageFor } from '../lib/errors'
import {
  canMove,
  copyName,
  freeName,
  pathOf,
  subtree,
  type TreeItem,
} from '../lib/folderTree'
import {
  useChildDocuments,
  useChildFolders,
  useDocuments,
  useFolders,
  useRoster,
  useTeacherDocuments,
} from '../lib/queries'
import { setClip, useClip } from './clipboard'
import { ContextMenu, SEPARATOR, type ContextEntry } from './ContextMenu'
import { useDesk } from './context'
import { placeKey, storeFor, useFileStore, type FileStore, type Place } from './fileStore'

type FolderRow = Schemas['FolderOut']
type FileRow = Schemas['DocumentSummaryOut']

const VIEW_KEY = 'yogucode-finder-view'

function savedView(): 'icons' | 'list' {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'icons'
  } catch {
    return 'icons'
  }
}

export function Finder() {
  const { role } = useDesk()
  const { studentId } = useParams()
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  if (role === 'student') return <StudentFiles recents={params.get('view') === 'recents'} />
  if (studentId) return <ChildFiles studentId={studentId} />
  if (pathname === '/files/mine') return <MyFiles />
  // `/files`: nothing chosen yet.
  return (
    <Shell place={null} title="Files" loading={false} error={null} folders={[]} files={[]} store={null} onOpenFile={() => {}} />
  )
}

const TEACHER: Place = { kind: 'teacher' }
const ME: Place = { kind: 'me' }

function MyFiles() {
  const navigate = useNavigate()
  const folders = useFolders('teacher')
  const files = useTeacherDocuments()
  const actions = useFileStore(TEACHER)
  return (
    <Shell
      store={{ place: TEACHER, actions }}
      place="mine"
      title="My code"
      loading={folders.isPending || files.isPending}
      error={folders.error ?? files.error}
      folders={folders.data ?? []}
      files={files.data ?? []}
      onOpenFile={(file) => navigate(`/my-code?open=${file.id}`)}
    />
  )
}

function ChildFiles({ studentId }: { studentId: string }) {
  const navigate = useNavigate()
  const folders = useChildFolders(studentId)
  const files = useChildDocuments(studentId)
  const child: Place = { kind: 'child', studentId }
  const actions = useFileStore(child)
  return (
    <Shell
      store={{ place: child, actions }}
      place={studentId}
      title={null}
      loading={folders.isPending || files.isPending}
      error={folders.error ?? files.error}
      folders={folders.data ?? []}
      files={files.data ?? []}
      onOpenFile={(file) => navigate(`/code/students/${studentId}/${file.id}`)}
    />
  )
}

function StudentFiles({ recents }: { recents: boolean }) {
  const navigate = useNavigate()
  const folders = useFolders('me')
  const files = useDocuments()
  const actions = useFileStore(ME)
  return (
    <Shell
      store={{ place: ME, actions }}
      place={recents ? 'recents' : 'mine'}
      title={recents ? 'Recents' : 'My work'}
      loading={folders.isPending || files.isPending}
      error={folders.error ?? files.error}
      // Recents: the newest files, wherever they are, and no folders.
      folders={recents ? [] : (folders.data ?? [])}
      files={recents ? (files.data ?? []).slice(0, 12) : (files.data ?? [])}
      flat={recents}
      onOpenFile={(file) => navigate(`/work?open=${file.id}`)}
    />
  )
}

/* --- the window: sidebar, toolbar, contents, status bar ------------------------------- */

const DRAG_TYPE = 'application/x-yogucode-finder'
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'

function Shell({
  place,
  title,
  loading,
  error,
  folders,
  files,
  flat = false,
  store,
  onOpenFile,
}: {
  /** Which sidebar place is chosen: a child's id, "mine", "recents", or none. */
  place: string | null
  /** The place's name, or null to take it from the sidebar (a child's name). */
  title: string | null
  loading: boolean
  error: Error | null
  folders: FolderRow[]
  files: FileRow[]
  /** Show every file at once, ignoring folders (Recents). */
  flat?: boolean
  /** Where changes go; none for a place that is only a prompt to choose one. */
  store: { place: Place; actions: FileStore } | null
  onOpenFile: (file: FileRow) => void
}) {
  const [params, setParams] = useSearchParams()
  const folderId = flat ? null : params.get('folder')
  // `?select=<id>`: a file to show selected, as "Put it away in Files…" sends (18 Oct 2026).
  const asked = params.get('select')
  const [selected, setSelected] = useState<string | null>(asked)
  const [lastAsked, setLastAsked] = useState(asked)
  if (asked !== lastAsked) {
    setLastAsked(asked)
    if (asked) setSelected(asked)
  }
  const [view, setView] = useState<'icons' | 'list'>(savedView)
  const [menu, setMenu] = useState<{ x: number; y: number; item: Item | null } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Item | null>(null)
  const [moving, setMoving] = useState<Item | null>(null)
  const [moveTarget, setMoveTarget] = useState('')
  const [dropOn, setDropOn] = useState<string | null | undefined>(undefined)
  const [problem, setProblem] = useState<string | null>(null)
  const clip = useClip()
  const client = useQueryClient()
  const contents = useRef<HTMLDivElement>(null)
  const places = usePlaces()
  const placeName = title ?? places.flatMap((s) => s.items).find((p) => p.key === place)?.label ?? 'Files'

  const byId = new Map(folders.map((f) => [f.id, f]))
  const trail: FolderRow[] = []
  for (let f = folderId ? byId.get(folderId) : undefined; f; f = f.parent_id ? byId.get(f.parent_id) : undefined) {
    trail.unshift(f)
  }

  const here = flat ? null : (trail.at(-1)?.id ?? null)
  const items: Item[] = [
    ...folders
      .filter((f) => f.parent_id === here)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f): Item => ({ kind: 'folder', id: f.id, name: f.name, changed: f.updated_at })),
    ...files
      .filter((f) => flat || f.folder_id === here)
      .sort((a, b) => (flat ? 0 : a.title.localeCompare(b.title)))
      .map((f): Item => ({ kind: 'file', id: f.id, name: f.title, changed: f.updated_at, file: f })),
  ]
  const chosen = items.find((i) => i.id === selected) ?? null
  const actions = store?.actions ?? null

  function goTo(id: string | null) {
    setSelected(null)
    setRenaming(null)
    const next = new URLSearchParams(params)
    if (id) next.set('folder', id)
    else next.delete('folder')
    setParams(next)
  }

  function open(item: Item) {
    if (item.kind === 'folder') goTo(item.id)
    else onOpenFile(item.file!)
  }

  function chooseView(next: 'icons' | 'list') {
    setView(next)
    try {
      window.localStorage.setItem(VIEW_KEY, next)
    } catch {
      // Private window or blocked storage: the view just isn't remembered.
    }
  }

  /** Run a change, saying in not-yet words when the server refuses it. */
  async function attempt<T>(work: () => Promise<T>): Promise<T | null> {
    setProblem(null)
    try {
      return await work()
    } catch (refused) {
      setProblem(messageFor(refused))
      return null
    }
  }

  /* --- the actions ----------------------------------------------------------------- */

  async function newFolder() {
    if (!actions || flat) return
    const taken = folders.filter((f) => f.parent_id === here).map((f) => f.name)
    const made = await attempt(() => actions.createFolder(freeName('untitled folder', taken), here))
    if (made) {
      setSelected(made.id)
      setRenaming(made.id)
    }
  }

  async function newFile() {
    if (!actions) return
    // The server numbers it — untitled.py, untitled2.py — so two presses never clash.
    const made = await attempt(() => actions.createFile(here))
    if (made) {
      setSelected(made.id)
      setRenaming(made.id)
    }
  }

  async function rename(item: Item, name: string) {
    if (!actions) return
    const next = name.trim()
    if (!next || next === item.name) {
      setRenaming(null)
      return
    }
    const done = await attempt(() =>
      item.kind === 'file' ? actions.renameFile(item.id, next) : actions.renameFolder(item.id, next),
    )
    // A refused name keeps the box open, so it can be fixed rather than retyped.
    if (done !== null) setRenaming(null)
  }

  async function moveInto(item: TreeItem, target: string | null) {
    if (!actions || !canMove(item, target, files, folders)) return
    await attempt(() =>
      item.kind === 'file' ? actions.moveFile(item.id, target) : actions.moveFolder(item.id, target),
    )
  }

  async function duplicate(item: Item) {
    if (!actions || item.kind !== 'file') return
    const taken = files.filter((f) => f.folder_id === (item.file?.folder_id ?? null)).map((f) => f.title)
    const content = await attempt(() => actions.readContent(item.id))
    if (content === null) return
    const made = await attempt(() =>
      actions.createFile(item.file?.folder_id ?? null, copyName(item.name, taken), content),
    )
    if (made) setSelected(made.id)
  }

  async function remove(item: Item) {
    if (!actions) return
    await attempt(() => (item.kind === 'file' ? actions.deleteFile(item.id) : actions.deleteFolder(item.id)))
    setSelected(null)
  }

  function clipTo(mode: 'cut' | 'copy', item: Item) {
    if (!store) return
    setClip({ mode, place: store.place, items: [{ kind: item.kind, id: item.id, name: item.name }] })
  }

  /**
   * Paste what was cut or copied into the folder being looked at. A cut within the same
   * place is a move; anything else makes copies — from another place too, which is how a
   * teacher hands a file from My code to a child.
   */
  async function paste() {
    if (!actions || !store || !clip || flat) return
    const samePlace = placeKey(clip.place) === placeKey(store.place)
    if (clip.mode === 'cut' && samePlace) {
      for (const item of clip.items) await moveInto(item, here)
      setClip(null)
      return
    }
    const from = samePlace ? actions : storeFor(client, clip.place)
    for (const item of clip.items) {
      if (item.kind === 'folder') {
        if (!samePlace) {
          setProblem('Folders can only be copied within the same place — copy the files inside instead.')
          continue
        }
        await copyFolder(item.id, here)
        continue
      }
      const taken = files.filter((f) => f.folder_id === here).map((f) => f.title)
      const content = await attempt(() => from.readContent(item.id))
      if (content === null) continue
      await attempt(() => actions.createFile(here, freeName(item.name, taken), content))
    }
    if (clip.mode === 'cut') setClip(null)
  }

  /** A folder and everything in it, copied into `parent` — within one place. */
  async function copyFolder(sourceId: string, parent: string | null) {
    if (!actions) return
    const source = byId.get(sourceId)
    if (!source || (parent && subtree(folders, sourceId).has(parent))) {
      setProblem('A folder can’t be copied into itself.')
      return
    }
    const taken = folders.filter((f) => f.parent_id === parent).map((f) => f.name)
    const made = await attempt(() => actions.createFolder(freeName(source.name, taken), parent))
    if (!made) return
    for (const file of files.filter((f) => f.folder_id === sourceId)) {
      const content = await attempt(() => actions.readContent(file.id))
      if (content !== null) await attempt(() => actions.createFile(made.id, file.title, content))
    }
    for (const child of folders.filter((f) => f.parent_id === sourceId)) await copyFolder(child.id, made.id)
  }

  /* --- the menu, and the keys ------------------------------------------------------ */

  function entriesFor(item: Item | null): ContextEntry[] {
    if (!actions) return item ? [{ label: 'Open', onSelect: () => open(item) }] : []
    if (!item) {
      return [
        ...(flat ? [] : [{ label: 'New folder', shortcut: `${MOD}⇧N`, onSelect: () => void newFolder() }]),
        { label: 'New file', onSelect: () => void newFile() },
        ...(flat ? [] : [SEPARATOR, { label: 'Paste', shortcut: `${MOD}V`, disabled: !clip, onSelect: () => void paste() }]),
        SEPARATOR,
        { label: view === 'icons' ? 'Show as list' : 'Show as icons', onSelect: () => chooseView(view === 'icons' ? 'list' : 'icons') },
      ]
    }
    const file = item.kind === 'file'
    return [
      { label: 'Open', shortcut: '↵', onSelect: () => open(item) },
      SEPARATOR,
      { label: 'Rename', shortcut: 'F2', onSelect: () => setRenaming(item.id) },
      ...(file ? [{ label: 'Duplicate', shortcut: `${MOD}D`, onSelect: () => void duplicate(item) }] : []),
      ...(flat
        ? []
        : [
            { label: 'Cut', shortcut: `${MOD}X`, onSelect: () => clipTo('cut', item) },
            { label: 'Copy', shortcut: `${MOD}C`, onSelect: () => clipTo('copy', item) },
            {
              label: 'Move to…',
              onSelect: () => {
                setMoveTarget('')
                setMoving(item)
              },
            },
          ]),
      SEPARATOR,
      { label: 'Delete', shortcut: '⌫', onSelect: () => setDeleting(item) },
    ]
  }

  function openMenu(event: React.MouseEvent, item: Item | null) {
    event.preventDefault()
    event.stopPropagation()
    if (place === null) return
    setSelected(item?.id ?? null)
    setMenu({ x: event.clientX, y: event.clientY, item })
  }

  function onKeys(event: React.KeyboardEvent) {
    if ((event.target as HTMLElement).closest('input, textarea, select') || renaming) return
    const mod = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    const index = chosen ? items.indexOf(chosen) : -1
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      const box = (chosen && contents.current?.querySelector(`[data-item="${chosen.id}"]`)) || contents.current
      const rect = box?.getBoundingClientRect()
      setMenu({ x: rect?.left ?? 0, y: rect?.bottom ?? 0, item: chosen })
      return
    }
    if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key) && !mod) {
      if (items.length === 0) return
      event.preventDefault()
      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1
      const next = items[index === -1 ? 0 : Math.max(0, Math.min(items.length - 1, index + step))]!
      setSelected(next.id)
      contents.current?.querySelector<HTMLElement>(`[data-item="${next.id}"]`)?.focus()
      return
    }
    if (mod && event.shiftKey && key === 'n') {
      event.preventDefault()
      void newFolder()
      return
    }
    if (mod && key === 'v') {
      event.preventDefault()
      void paste()
      return
    }
    if (!chosen) return
    if (event.key === 'Enter') {
      event.preventDefault()
      open(chosen)
    } else if (event.key === 'F2' && actions) {
      event.preventDefault()
      setRenaming(chosen.id)
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && actions) {
      event.preventDefault()
      setDeleting(chosen)
    } else if (mod && key === 'c' && !flat) {
      event.preventDefault()
      clipTo('copy', chosen)
    } else if (mod && key === 'x' && !flat) {
      event.preventDefault()
      clipTo('cut', chosen)
    } else if (mod && key === 'd') {
      event.preventDefault()
      void duplicate(chosen)
    }
  }

  /* --- dragging -------------------------------------------------------------------- */

  function dragProps(item: Item) {
    if (!actions || flat || renaming === item.id) return {}
    return {
      draggable: true,
      onDragStart: (event: React.DragEvent) => {
        event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: item.kind, id: item.id }))
        event.dataTransfer.effectAllowed = 'move'
        setSelected(item.id)
      },
      onDragEnd: () => setDropOn(undefined),
    }
  }

  /** A folder icon or a crumb in the path: drop here to move into `target` (null: the top). */
  function dropProps(target: string | null) {
    if (!actions || flat) return {}
    return {
      onDragOver: (event: React.DragEvent) => {
        if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
        event.preventDefault()
        event.stopPropagation()
        setDropOn(target)
      },
      onDragLeave: () => setDropOn(undefined),
      onDrop: (event: React.DragEvent) => {
        event.preventDefault()
        event.stopPropagation()
        setDropOn(undefined)
        const raw = event.dataTransfer.getData(DRAG_TYPE)
        if (raw) void moveInto(JSON.parse(raw) as TreeItem, target)
      },
    }
  }

  function itemProps(item: Item) {
    return {
      'data-item': item.id,
      'aria-label': `${item.name}, ${item.kind}`,
      'aria-pressed': item.id === selected,
      onClick: (event: React.MouseEvent) => {
        event.stopPropagation()
        setSelected(item.id)
      },
      onDoubleClick: () => renaming !== item.id && open(item),
      onContextMenu: (event: React.MouseEvent) => openMenu(event, item),
      ...dragProps(item),
      ...(item.kind === 'folder' ? dropProps(item.id) : {}),
    }
  }

  function label(item: Item, className: string) {
    if (renaming === item.id) {
      return <RenameBox name={item.name} onDone={(name) => void rename(item, name)} onCancel={() => setRenaming(null)} />
    }
    return <span className={className}>{item.name}</span>
  }

  const moveChoices = moving
    ? folders
        .filter((f) => moving.kind === 'file' || !subtree(folders, moving.id).has(f.id))
        .map((f) => ({ id: f.id, label: pathOf(folders, f.id) }))
        .sort((a, b) => a.label.localeCompare(b.label))
    : []

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        <button
          type="button"
          aria-label="Back"
          disabled={trail.length === 0}
          onClick={() => goTo(trail.at(-2)?.id ?? null)}
          className="flex h-8 w-8 items-center justify-center rounded-xl text-grape hover:bg-grape-pale disabled:text-line disabled:hover:bg-transparent"
        >
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <nav aria-label="Folder path" className="flex min-w-0 flex-wrap items-center">
          <Crumb current={trail.length === 0} onClick={() => goTo(null)} dropping={dropOn === null} drop={dropProps(null)}>
            {placeName}
          </Crumb>
          {trail.map((f, i) => (
            <span key={f.id} className="flex items-center">
              <ChevronRight size={14} aria-hidden="true" className="text-lavender" />
              <Crumb current={i === trail.length - 1} onClick={() => goTo(f.id)} dropping={dropOn === f.id} drop={dropProps(f.id)}>
                {f.name}
              </Crumb>
            </span>
          ))}
        </nav>
        <span className="flex-1" />
        {actions ? (
          <>
            {flat ? null : (
              <ToolButton label="New folder" onClick={() => void newFolder()}>
                <FolderPlus size={17} aria-hidden="true" />
              </ToolButton>
            )}
            <ToolButton label="New file" onClick={() => void newFile()}>
              <FilePlus2 size={17} aria-hidden="true" />
            </ToolButton>
          </>
        ) : null}
        <button
          type="button"
          disabled={!chosen}
          onClick={() => chosen && open(chosen)}
          className="rounded-xl bg-grape px-3.5 py-1.5 text-sm font-medium text-surface disabled:bg-grape-pale disabled:text-lavender"
        >
          Open
        </button>
        <div role="group" aria-label="View" className="flex rounded-xl bg-grape-pale/60 p-0.5">
          <ViewButton label="Icons" on={view === 'icons'} onClick={() => chooseView('icons')}>
            <LayoutGrid size={16} aria-hidden="true" />
          </ViewButton>
          <ViewButton label="List" on={view === 'list'} onClick={() => chooseView('list')}>
            <List size={16} aria-hidden="true" />
          </ViewButton>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <nav aria-label="Places" className="hidden w-48 shrink-0 flex-col gap-4 overflow-auto border-r border-line bg-cream/60 px-2 py-3 sm:flex">
          {places.map((section) => (
            <div key={section.title} className="flex flex-col">
              <span className="px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
                {section.title}
              </span>
              {section.items.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  aria-current={p.key === place ? 'page' : undefined}
                  onClick={p.go}
                  className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm ${
                    p.key === place ? 'bg-grape-pale font-semibold text-grape' : 'text-grape hover:bg-grape-pale/50'
                  }`}
                >
                  <p.icon size={15} aria-hidden="true" className="shrink-0" />
                  <span className="truncate">{p.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div
          ref={contents}
          role="region"
          aria-label="Folder contents"
          className="flex min-w-0 flex-1 flex-col overflow-auto p-4"
          onClick={() => setSelected(null)}
          onContextMenu={(event) => openMenu(event, null)}
          onKeyDown={onKeys}
        >
          {problem ? (
            <div className="mb-3">
              <Notice tone="not-yet">{problem}</Notice>
            </div>
          ) : null}
          {actions && asked && chosen?.id === asked ? (
            <div className="mb-3">
              <Notice tone="info">
                Here’s {chosen.name}. Drag it onto a folder to put it there — it keeps saving
                wherever it goes.
              </Notice>
            </div>
          ) : null}
          {place === null ? (
            <p className="p-6 text-center text-sm text-muted">Choose a student, or My code, on the left.</p>
          ) : loading ? (
            <Spinner label="Loading files" />
          ) : error ? (
            <Notice tone="system-error">{messageFor(error)}</Notice>
          ) : items.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted">
              This folder is empty.{actions ? ' Right-click to make a folder or a file.' : ''}
            </p>
          ) : view === 'icons' ? (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(108px,1fr))] content-start gap-2">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    {...itemProps(item)}
                    className="group flex w-full cursor-default flex-col items-center gap-1.5 rounded-xl px-1 py-1.5 text-grape"
                  >
                    <span
                      className={`flex h-[72px] w-20 items-center justify-center rounded-xl ${
                        dropOn === item.id
                          ? 'bg-grape-pale ring-2 ring-grape'
                          : item.id === selected
                            ? 'bg-grape-pale'
                            : 'group-hover:bg-grape-pale/40'
                      }`}
                    >
                      {item.kind === 'folder' ? <FolderIcon /> : <FileIcon name={item.name} />}
                    </span>
                    {label(
                      item,
                      `max-w-[104px] break-words rounded-md px-1.5 text-center text-[13px] leading-tight ${
                        item.id === selected ? 'bg-grape text-surface' : ''
                      }`,
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <table className="w-full min-w-[360px] text-left text-sm">
              <thead className="text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="px-2.5 py-1.5 font-semibold">Name</th>
                  <th className="px-2.5 py-1.5 font-semibold">Kind</th>
                  <th className="px-2.5 py-1.5 font-semibold">Changed</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const on = item.id === selected
                  return (
                    <tr
                      key={item.id}
                      onClick={(event) => {
                        event.stopPropagation()
                        setSelected(item.id)
                      }}
                      onDoubleClick={() => renaming !== item.id && open(item)}
                      onContextMenu={(event) => openMenu(event, item)}
                      className={dropOn === item.id ? 'bg-grape-pale' : on ? 'bg-grape text-surface' : 'text-grape'}
                    >
                      <td className="rounded-l-lg px-2.5 py-1.5">
                        <button type="button" {...itemProps(item)} className="flex cursor-default items-center gap-2">
                          {item.kind === 'folder' ? (
                            <Folder size={16} aria-hidden="true" className={on ? '' : 'text-lavender'} />
                          ) : (
                            <span aria-hidden="true" className={`h-4 w-3 rounded-sm ${on ? 'bg-surface' : badgeColour(item.name)}`} />
                          )}
                          {label(item, '')}
                        </button>
                      </td>
                      <td className={`px-2.5 py-1.5 ${on ? '' : 'text-muted'}`}>{kindOf(item)}</td>
                      <td className={`rounded-r-lg px-2.5 py-1.5 ${on ? '' : 'text-muted'}`}>{changedOn(item.changed)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          {/* The empty space below the items is part of the folder: right-click it, drop on it. */}
          <div className="min-h-8 flex-1" />
        </div>
      </div>

      <div className="flex shrink-0 justify-between gap-2 border-t border-line bg-cream/60 px-3.5 py-1.5 text-xs text-muted">
        <span>
          {items.length} {items.length === 1 ? 'item' : 'items'}
          {chosen ? ` · ${chosen.name} selected` : ''}
          {clip ? ` · ${clip.items[0]?.name} ${clip.mode === 'cut' ? 'cut' : 'copied'}` : ''}
        </span>
        <span>{actions ? 'Double-click to open · right-click for more' : 'Double-click to open'}</span>
      </div>

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.item ? `${menu.item.name} actions` : 'Folder actions'}
          entries={entriesFor(menu.item)}
          onClose={() => setMenu(null)}
        />
      ) : null}

      <Dialog
        open={deleting !== null}
        title={deleting ? `Delete ${deleting.name}?` : ''}
        onClose={() => setDeleting(null)}
        confirm={{
          label: 'Delete',
          onConfirm: () => {
            const item = deleting
            setDeleting(null)
            if (item) void remove(item)
          },
        }}
      >
        {deleting?.kind === 'folder'
          ? 'The folder and everything in it leave this place. They are put away rather than destroyed, so they can be brought back.'
          : 'It leaves this folder. It is put away rather than destroyed, so it can be brought back.'}
      </Dialog>

      <Dialog
        open={moving !== null}
        title={moving ? `Move ${moving.name}` : ''}
        onClose={() => setMoving(null)}
        confirm={{
          label: 'Move',
          onConfirm: () => {
            const item = moving
            setMoving(null)
            if (item) void moveInto(item, moveTarget || null)
          },
        }}
      >
        <Select label="Move to" value={moveTarget} onChange={(event) => setMoveTarget(event.target.value)}>
          <option value="">{placeName} (the top)</option>
          {moveChoices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </Select>
      </Dialog>
    </div>
  )
}

/** Naming in place: the name selected up to its extension, Enter keeps, Escape cancels. */
function RenameBox({ name, onDone, onCancel }: { name: string; onDone: (name: string) => void; onCancel: () => void }) {
  const box = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(name)
  useEffect(() => {
    const input = box.current
    if (!input) return
    input.focus()
    const dot = name.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : name.length)
  }, [name])
  return (
    <input
      ref={box}
      aria-label={`New name for ${name}`}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') onDone(value)
        if (event.key === 'Escape') onCancel()
      }}
      onBlur={() => onDone(value)}
      className="w-[104px] rounded-md bg-surface px-1.5 text-center text-[13px] text-grape ring-2 ring-grape outline-none"
    />
  )
}

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-xl text-grape hover:bg-grape-pale"
    >
      {children}
    </button>
  )
}

interface Item {
  kind: 'folder' | 'file'
  id: string
  name: string
  changed: string
  file?: FileRow
}

interface SidebarPlace {
  key: string
  label: string
  icon: typeof Folder
  go: () => void
}

/** The sidebar: a teacher's class and My code, or a child's Recents and My work. */
function usePlaces(): { title: string; items: SidebarPlace[] }[] {
  const { role, classId } = useDesk()
  const navigate = useNavigate()
  const roster = useRoster(classId ?? '', role === 'teacher')
  if (role === 'student') {
    return [
      {
        title: 'Favourites',
        items: [
          { key: 'recents', label: 'Recents', icon: Clock, go: () => navigate('/my-files?view=recents') },
          { key: 'mine', label: 'My work', icon: Folder, go: () => navigate('/my-files') },
        ],
      },
    ]
  }
  return [
    ...(classId
      ? [
          {
            title: 'This class',
            items: (roster.data ?? []).map((s) => ({
              key: s.student_id,
              label: s.display_name,
              icon: User,
              go: () => navigate(`/files/students/${s.student_id}`),
            })),
          },
        ]
      : []),
    { title: 'Me', items: [{ key: 'mine', label: 'My code', icon: Folder, go: () => navigate('/files/mine') }] },
  ]
}

function Crumb({
  current,
  onClick,
  children,
  dropping = false,
  drop = {},
}: {
  current: boolean
  onClick: () => void
  children: ReactNode
  /** Something is being dragged over it. */
  dropping?: boolean
  /** Dropping here moves into this folder — Finder's path bar does the same. */
  drop?: object
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? 'location' : undefined}
      {...drop}
      className={`rounded-lg px-2 py-1 text-sm hover:bg-grape-pale ${current ? 'font-semibold text-grape' : 'text-muted'} ${
        dropping ? 'bg-grape-pale ring-2 ring-grape' : ''
      }`}
    >
      {children}
    </button>
  )
}

function ViewButton({ label, on, onClick, children }: { label: string; on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      onClick={onClick}
      className={`flex h-7 w-8 items-center justify-center rounded-lg ${on ? 'bg-surface text-grape' : 'text-muted hover:text-grape'}`}
    >
      {children}
    </button>
  )
}

const extOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toUpperCase().slice(0, 4) : '')
const badgeColour = (name: string) => (extOf(name) === 'PY' ? 'bg-grape' : 'bg-muted')

function kindOf(item: Item): string {
  if (item.kind === 'folder') return 'Folder'
  return extOf(item.name) === 'PY' ? 'Python file' : 'Text file'
}

function changedOn(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

function FolderIcon() {
  return (
    <svg width="64" height="54" viewBox="0 0 64 54" aria-hidden="true">
      <path d="M3 9a6 6 0 0 1 6-6h14.5a4 4 0 0 1 3 1.4L31 9h24a6 6 0 0 1 6 6v30a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6z" fill="#9C8BDB" />
      <path d="M3 18a5 5 0 0 1 5-5h48a5 5 0 0 1 5 5v27a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6z" fill="#B9ACE6" />
      <path d="M3 18a5 5 0 0 1 5-5h48a5 5 0 0 1 5 5v2H3z" fill="#C9BFF0" />
    </svg>
  )
}

function FileIcon({ name }: { name: string }) {
  const ext = extOf(name)
  return (
    <svg width="50" height="62" viewBox="0 0 50 62" aria-hidden="true">
      <path d="M6 1.5h26l16.5 16.5V56a4.5 4.5 0 0 1-4.5 4.5H6A4.5 4.5 0 0 1 1.5 56V6A4.5 4.5 0 0 1 6 1.5z" fill="#FFFFFF" stroke="#D9CFF2" strokeWidth="2" />
      <path d="M32 1.5V13a5 5 0 0 0 5 5h11.5" fill="#F6F3FD" stroke="#D9CFF2" strokeWidth="2" />
      <path d="M9 22h18M9 27h24M13 32h16" stroke="#D9CFF2" strokeWidth="2" strokeLinecap="round" />
      {ext ? (
        <>
          <rect x="8" y="40" width="34" height="14" rx="5" fill={ext === 'PY' ? '#4B2FB8' : '#6A58A8'} />
          <text x="25" y="50.5" textAnchor="middle" fontSize="9.5" fontWeight="700" fill="#FFFFFF" fontFamily="ui-monospace,Menlo,Consolas,monospace">
            {ext}
          </text>
        </>
      ) : null}
    </svg>
  )
}
