/**
 * The dock's apps, and which pages each one owns (Ken's decisions, 16 Oct 2026).
 *
 * Every page the app already had belongs to exactly one app here. That is what lets the
 * existing screens move onto the desktop unchanged: a link or `navigate()` anywhere goes to
 * a URL, the URL names an app, and that app's window opens (or comes to the front) showing
 * it. Grouped apps — Classes, Work, Library — switch between their pages with tabs.
 */

import type { LucideIcon } from 'lucide-react'
import {
  BarChart3,
  BookOpen,
  ClipboardCheck,
  ClipboardList,
  Code2,
  FolderOpen,
  GraduationCap,
  Radio,
  Users,
} from 'lucide-react'

export type Role = 'teacher' | 'student'

export type AppId =
  | 'live'
  | 'classes'
  | 'files'
  | 'code'
  | 'work'
  | 'marking'
  | 'progress'
  | 'library'
  | 'lessons'

export interface Ctx {
  classId: string | null
  isOwner: boolean
}

export interface Tab {
  label: string
  to: string
  active: (pathname: string, search: string) => boolean
}

export interface AppDef {
  id: AppId
  label: string
  /** The dock tooltip and search hint. */
  hint: string
  icon: LucideIcon
  /** Dock tile colours: Tailwind classes, from the brand only. */
  tile: string
  /** Pages this app owns. Checked in dock order; the first match wins. */
  owns: RegExp[]
  /** Where the app opens from the dock. */
  home: (ctx: Ctx) => string
  tabs?: (ctx: Ctx) => Tab[]
  /** Window title context: shows the class name for pages about one class. */
  classScoped?: boolean
}

const CLASS = '/classes/[^/]+'
const tabParam = (search: string) => new URLSearchParams(search).get('tab')

const TEACHER: AppDef[] = [
  {
    id: 'live',
    label: 'Live',
    hint: 'This lesson, live',
    icon: Radio,
    tile: 'bg-strawberry text-surface',
    owns: [new RegExp(`^${CLASS}/live$`)],
    home: (c) => (c.classId ? `/classes/${c.classId}/live` : '/classes'),
    classScoped: true,
  },
  {
    id: 'work',
    label: 'Work',
    hint: 'Homework and quizzes',
    icon: ClipboardList,
    tile: 'bg-grape-pale text-grape',
    owns: [new RegExp(`^${CLASS}/(work|homework|quizzes)(/|$)`)],
    home: (c) => (c.classId ? `/classes/${c.classId}/work` : '/classes'),
    tabs: (c) =>
      c.classId
        ? [
            {
              label: 'Homework',
              to: `/classes/${c.classId}/work`,
              active: (p, s) => p.includes('/homework') || (p.endsWith('/work') && tabParam(s) !== 'quizzes'),
            },
            {
              label: 'Quizzes',
              to: `/classes/${c.classId}/work?tab=quizzes`,
              active: (p, s) => p.includes('/quizzes') || (p.endsWith('/work') && tabParam(s) === 'quizzes'),
            },
          ]
        : [],
    classScoped: true,
  },
  {
    id: 'progress',
    label: 'Progress',
    hint: 'Who has got what',
    icon: BarChart3,
    tile: 'bg-grape-pale text-grape',
    owns: [new RegExp(`^${CLASS}/progress$`)],
    home: (c) => (c.classId ? `/classes/${c.classId}/progress` : '/classes'),
    classScoped: true,
  },
  {
    id: 'marking',
    label: 'Marking',
    hint: 'Mark handed-in work',
    icon: ClipboardCheck,
    tile: 'bg-grape-pale text-grape',
    owns: [new RegExp(`^${CLASS}/marking$`), /^\/assignments\/[^/]+\/mark(\/|$)/],
    home: (c) => (c.classId ? `/classes/${c.classId}/marking` : '/classes'),
    classScoped: true,
  },
  {
    id: 'classes',
    label: 'Classes',
    hint: 'Students, PINs and teachers',
    icon: Users,
    tile: 'bg-grape-pale text-grape',
    owns: [/^\/classes(\/[^/]+(\/slips)?)?\/?$/, /^\/students\//, /^\/teachers$/],
    home: (c) => (c.classId ? `/classes/${c.classId}` : '/classes'),
    tabs: (c) => [
      {
        label: 'Students',
        to: c.classId ? `/classes/${c.classId}` : '/classes',
        active: (p) => p.startsWith('/classes') || p.startsWith('/students/'),
      },
      ...(c.isOwner
        ? [{ label: 'Teachers', to: '/teachers', active: (p: string) => p === '/teachers' }]
        : []),
    ],
    classScoped: true,
  },
  {
    id: 'files',
    label: 'Files',
    hint: 'Everyone’s files',
    icon: FolderOpen,
    tile: 'bg-lemon text-grape',
    owns: [/^\/files(\/|$)/, /^\/trash$/],
    home: () => '/files',
    // Everything deleted at the centre waits in the Trash for 30 days (23 Oct 2026).
    tabs: () => [
      { label: 'Files', to: '/files', active: (p) => p.startsWith('/files') },
      { label: 'Trash', to: '/trash', active: (p) => p === '/trash' },
    ],
  },
  {
    id: 'code',
    label: 'Code',
    hint: 'The code editor',
    icon: Code2,
    tile: 'bg-night text-lemon',
    owns: [/^\/my-code$/, /^\/code\//],
    home: () => '/my-code',
  },
  {
    id: 'library',
    label: 'Library',
    hint: 'Problems and curriculum',
    icon: BookOpen,
    tile: 'bg-grape-pale text-grape',
    owns: [/^\/problems(\/|$)/, /^\/curriculum$/],
    home: () => '/problems',
    tabs: () => [
      { label: 'Problems', to: '/problems', active: (p) => p.startsWith('/problems') },
      { label: 'Curriculum', to: '/curriculum', active: (p) => p === '/curriculum' },
    ],
  },
]

const STUDENT: AppDef[] = [
  {
    id: 'lessons',
    label: 'Lessons',
    hint: 'Today’s lesson',
    icon: GraduationCap,
    tile: 'bg-grape text-surface',
    owns: [/^\/home$/, /^\/lesson\//],
    home: () => '/home',
  },
  {
    id: 'code',
    label: 'Code',
    hint: 'Your files, in the editor',
    icon: Code2,
    tile: 'bg-night text-lemon',
    owns: [/^\/work$/],
    home: () => '/work',
  },
  {
    id: 'files',
    label: 'Files',
    hint: 'Your work, in folders',
    icon: FolderOpen,
    tile: 'bg-lemon text-grape',
    owns: [/^\/my-files$/],
    home: () => '/my-files',
  },
  {
    id: 'work',
    label: 'Work',
    hint: 'Homework, quizzes, and lessons to finish',
    icon: ClipboardList,
    tile: 'bg-grape-pale text-grape',
    owns: [/^\/my-work$/, /^\/homework\//, /^\/quiz\//],
    home: () => '/my-work',
    tabs: () => [
      {
        label: 'Homework',
        to: '/my-work',
        active: (p, s) => p.startsWith('/homework/') || (p === '/my-work' && tabParam(s) === null),
      },
      {
        label: 'Quizzes',
        to: '/my-work?tab=quizzes',
        active: (p, s) => p.startsWith('/quiz/') || (p === '/my-work' && tabParam(s) === 'quizzes'),
      },
      {
        // Lesson problems already started, to finish at home (17 Oct 2026). They open in
        // the Lessons app, where every lesson problem is worked.
        label: 'Lessons',
        to: '/my-work?tab=lessons',
        active: (p, s) => p === '/my-work' && tabParam(s) === 'lessons',
      },
    ],
  },
]

const TEACHER_DOCK: AppId[] = ['live', 'classes', 'files', 'code', 'work', 'marking', 'progress', 'library']
const TEACHER_IN_ORDER = TEACHER_DOCK.map((id) => TEACHER.find((a) => a.id === id)!)

/** The dock, in order. The apps' page patterns are disjoint, so order never decides a match. */
export function appsFor(role: Role): AppDef[] {
  return role === 'teacher' ? TEACHER_IN_ORDER : STUDENT
}

export function appDef(role: Role, id: AppId): AppDef | undefined {
  return appsFor(role).find((a) => a.id === id)
}

/** Where an empty desktop sits: no app's page. The two roles never share a path. */
export function deskPath(role: Role): string {
  return role === 'teacher' ? '/desk' : '/my-desk'
}

/** Which app shows this page, or null for a page that is no app's (`/desk`). */
export function appFor(role: Role, pathname: string): AppId | null {
  for (const app of appsFor(role)) {
    if (app.owns.some((pattern) => pattern.test(pathname))) return app.id
  }
  return null
}

/** Pages that are an editor or a canvas fill the window; documents keep the reading column. */
export function fillsWindow(pathname: string): boolean {
  return /^\/(my-code|work|files|my-files|code\/|lesson\/)/.test(pathname)
}

/** The class a page is about, if it is about one. */
export function classOf(pathname: string): string | null {
  return /^\/classes\/([^/]+)/.exec(pathname)?.[1] ?? null
}
