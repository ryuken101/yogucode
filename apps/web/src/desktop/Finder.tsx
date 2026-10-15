/**
 * The Files app, in the style of the macOS Finder (Ken's decision, 16 Oct 2026).
 *
 * A sidebar of places, a toolbar (back, the folder path, Open, icon or list view), and the
 * folder's contents as real folder and file icons. One click selects, a double-click (or
 * Enter) opens: a folder opens in place, a file opens in Code.
 *
 * - A teacher's places are the children in the class chosen in the top bar, and their own
 *   My code. A child's files are read-only here (`/students/{id}/…`); opening one shows it
 *   in Code as "Watching", and changing it goes through Live's Help.
 * - A child's places are Recents and My work — their own files, which open in their editor.
 *
 * The folder being looked at is in the URL (`?folder=`), so Back and a reload keep it.
 * Organising — new folder, rename, move — stays in the editor's explorer, which already
 * does it; this is for finding and opening.
 */

import { ChevronLeft, ChevronRight, Clock, Folder, LayoutGrid, List, User } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import type { Schemas } from '../lib/api'
import { messageFor } from '../lib/errors'
import {
  useChildDocuments,
  useChildFolders,
  useDocuments,
  useFolders,
  useRoster,
  useTeacherDocuments,
} from '../lib/queries'
import { useDesk } from './context'

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
  return <Shell place={null} title="Files" loading={false} error={null} folders={[]} files={[]} onOpenFile={() => {}} />
}

function MyFiles() {
  const navigate = useNavigate()
  const folders = useFolders('teacher')
  const files = useTeacherDocuments()
  return (
    <Shell
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
  return (
    <Shell
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
  return (
    <Shell
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

function Shell({
  place,
  title,
  loading,
  error,
  folders,
  files,
  flat = false,
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
  onOpenFile: (file: FileRow) => void
}) {
  const [params, setParams] = useSearchParams()
  const folderId = flat ? null : params.get('folder')
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<'icons' | 'list'>(savedView)
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

  function goTo(id: string | null) {
    setSelected(null)
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

  const chosen = items.find((i) => i.id === selected) ?? null

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
          <Crumb current={trail.length === 0} onClick={() => goTo(null)}>
            {placeName}
          </Crumb>
          {trail.map((f, i) => (
            <span key={f.id} className="flex items-center">
              <ChevronRight size={14} aria-hidden="true" className="text-lavender" />
              <Crumb current={i === trail.length - 1} onClick={() => goTo(f.id)}>
                {f.name}
              </Crumb>
            </span>
          ))}
        </nav>
        <span className="flex-1" />
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

        <div className="min-w-0 flex-1 overflow-auto p-4" onClick={() => setSelected(null)}>
          {place === null ? (
            <p className="p-6 text-center text-sm text-muted">Choose a student, or My code, on the left.</p>
          ) : loading ? (
            <Spinner label="Loading files" />
          ) : error ? (
            <Notice tone="system-error">{messageFor(error)}</Notice>
          ) : items.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted">This folder is empty.</p>
          ) : view === 'icons' ? (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(108px,1fr))] content-start gap-2">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-label={`${item.name}, ${item.kind}`}
                    aria-pressed={item.id === selected}
                    onClick={(event) => {
                      event.stopPropagation()
                      setSelected(item.id)
                    }}
                    onDoubleClick={() => open(item)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') open(item)
                    }}
                    className="group flex w-full cursor-default flex-col items-center gap-1.5 rounded-xl px-1 py-1.5 text-grape"
                  >
                    <span
                      className={`flex h-[72px] w-20 items-center justify-center rounded-xl ${
                        item.id === selected ? 'bg-grape-pale' : 'group-hover:bg-grape-pale/40'
                      }`}
                    >
                      {item.kind === 'folder' ? <FolderIcon /> : <FileIcon name={item.name} />}
                    </span>
                    <span
                      className={`max-w-[104px] break-words rounded-md px-1.5 text-center text-[13px] leading-tight ${
                        item.id === selected ? 'bg-grape text-surface' : ''
                      }`}
                    >
                      {item.name}
                    </span>
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
                      onDoubleClick={() => open(item)}
                      className={on ? 'bg-grape text-surface' : 'text-grape'}
                    >
                      <td className="rounded-l-lg px-2.5 py-1.5">
                        <button
                          type="button"
                          aria-label={`${item.name}, ${item.kind}`}
                          aria-pressed={on}
                          onClick={(event) => {
                            event.stopPropagation()
                            setSelected(item.id)
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') open(item)
                          }}
                          className="flex cursor-default items-center gap-2"
                        >
                          {item.kind === 'folder' ? (
                            <Folder size={16} aria-hidden="true" className={on ? '' : 'text-lavender'} />
                          ) : (
                            <span aria-hidden="true" className={`h-4 w-3 rounded-sm ${on ? 'bg-surface' : badgeColour(item.name)}`} />
                          )}
                          {item.name}
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
        </div>
      </div>

      <div className="flex shrink-0 justify-between gap-2 border-t border-line bg-cream/60 px-3.5 py-1.5 text-xs text-muted">
        <span>
          {items.length} {items.length === 1 ? 'item' : 'items'}
          {chosen ? ` · ${chosen.name} selected` : ''}
        </span>
        <span>Double-click to open</span>
      </div>
    </div>
  )
}

interface Item {
  kind: 'folder' | 'file'
  id: string
  name: string
  changed: string
  file?: FileRow
}

interface Place {
  key: string
  label: string
  icon: typeof Folder
  go: () => void
}

/** The sidebar: a teacher's class and My code, or a child's Recents and My work. */
function usePlaces(): { title: string; items: Place[] }[] {
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

function Crumb({ current, onClick, children }: { current: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? 'location' : undefined}
      className={`rounded-lg px-2 py-1 text-sm hover:bg-grape-pale ${current ? 'font-semibold text-grape' : 'text-muted'}`}
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
