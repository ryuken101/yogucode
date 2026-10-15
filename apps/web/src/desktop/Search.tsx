/**
 * Search (Ctrl/⌘ K or the top bar): jump straight to an app, a class, a child, a piece of
 * work or a file, without going through the pages in between.
 *
 * Everything it finds is a URL, so choosing a result is an ordinary navigation and the
 * right app's window opens on it. It searches what the existing queries already hold —
 * no search endpoint — and fetches only while it is open.
 */

import { Search as SearchIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import type { AppDef, Role } from './apps'
import {
  useClassHomework,
  useClassQuizzes,
  useClasses,
  useDocuments,
  useHome,
  useRoster,
  useTeacherDocuments,
} from '../lib/queries'

export interface Found {
  label: string
  kind: string
  to: string
}

export function SearchPalette({
  open,
  onClose,
  role,
  classId,
  apps,
}: {
  open: boolean
  onClose: () => void
  role: Role
  classId: string | null
  apps: { def: AppDef; to: string }[]
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (open && !node.open) node.showModal?.()
    if (!open && node.open) node.close?.()
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-label="Search"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose()
      }}
      className="mx-auto mt-24 w-[min(600px,calc(100vw-32px))] overflow-hidden rounded-3xl border border-line bg-surface p-0 text-grape backdrop:bg-night/30"
    >
      {open ? (
        role === 'teacher' ? (
          <TeacherSearch classId={classId} apps={apps} onClose={onClose} />
        ) : (
          <StudentSearch apps={apps} onClose={onClose} />
        )
      ) : null}
    </dialog>
  )
}

function appResults(apps: { def: AppDef; to: string }[]): Found[] {
  return apps.map(({ def, to }) => ({ label: def.label, kind: 'App', to }))
}

function TeacherSearch({
  classId,
  apps,
  onClose,
}: {
  classId: string | null
  apps: { def: AppDef; to: string }[]
  onClose: () => void
}) {
  const classes = useClasses()
  const files = useTeacherDocuments()
  const everywhere: Found[] = [
    ...appResults(apps),
    ...(classes.data ?? []).map((c) => ({ label: c.name, kind: 'Class', to: `/classes/${c.id}` })),
    ...(files.data ?? []).map((f) => ({ label: f.title, kind: 'My code', to: `/my-code?open=${f.id}` })),
  ]
  return classId ? (
    <ClassSearch classId={classId} everywhere={everywhere} onClose={onClose} />
  ) : (
    <Results items={everywhere} onClose={onClose} />
  )
}

/** The class in the top bar adds its children, homework and quizzes. */
function ClassSearch({
  classId,
  everywhere,
  onClose,
}: {
  classId: string
  everywhere: Found[]
  onClose: () => void
}) {
  const roster = useRoster(classId)
  const homework = useClassHomework(classId)
  const quizzes = useClassQuizzes(classId)
  const children = roster.data ?? []
  return (
    <Results
      items={[
        ...everywhere,
        ...children.map((s) => ({ label: s.display_name, kind: 'Student', to: `/students/${s.student_id}` })),
        ...children.map((s) => ({
          label: `${s.display_name}’s files`,
          kind: 'Files',
          to: `/files/students/${s.student_id}`,
        })),
        ...(homework.data ?? []).map((h) => ({
          label: h.title,
          kind: 'Homework',
          to: `/classes/${classId}/homework/${h.id}`,
        })),
        ...(quizzes.data ?? []).map((q) => ({
          label: q.title,
          kind: 'Quiz',
          to: `/classes/${classId}/quizzes/${q.id}`,
        })),
      ]}
      onClose={onClose}
    />
  )
}

function StudentSearch({ apps, onClose }: { apps: { def: AppDef; to: string }[]; onClose: () => void }) {
  const home = useHome()
  const files = useDocuments()
  return (
    <Results
      items={[
        ...appResults(apps),
        ...(home.data?.homework ?? []).map((h) => ({
          label: h.title,
          kind: h.mode === 'quiz' ? 'Quiz' : 'Homework',
          to: h.mode === 'quiz' ? `/quiz/${h.assignment_id}` : `/homework/${h.assignment_id}`,
        })),
        ...(files.data ?? []).map((f) => ({ label: f.title, kind: 'File', to: `/work?open=${f.id}` })),
      ]}
      onClose={onClose}
    />
  )
}

function Results({ items, onClose }: { items: Found[]; onClose: () => void }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((it) => !q || `${it.label} ${it.kind}`.toLowerCase().includes(q)).slice(0, 10)
  }, [items, query])

  function go(found: Found) {
    onClose()
    navigate(found.to)
  }

  return (
    <div>
      <label className="flex items-center gap-3 border-b border-line px-5 py-3.5">
        <SearchIcon size={20} aria-hidden="true" className="text-muted" />
        <span className="sr-only">Search</span>
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && shown[0]) go(shown[0])
          }}
          placeholder="Search apps, students, work and files"
          className="min-w-0 flex-1 bg-transparent text-lg text-grape outline-none placeholder:text-muted"
        />
        <kbd className="rounded-md border border-line px-1.5 text-xs text-muted">Esc</kbd>
      </label>
      <ul className="max-h-96 overflow-auto p-1.5">
        {shown.map((found) => (
          <li key={`${found.kind}:${found.to}`}>
            <button
              type="button"
              onClick={() => go(found)}
              className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-grape-pale"
            >
              <span>{found.label}</span>
              <span className="rounded-full bg-cream px-2.5 py-0.5 text-xs text-muted">{found.kind}</span>
            </button>
          </li>
        ))}
        {shown.length === 0 ? (
          <li className="px-3 py-3 text-sm text-muted">Nothing matches “{query}”.</li>
        ) : null}
      </ul>
    </div>
  )
}
