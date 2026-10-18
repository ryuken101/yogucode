/**
 * The desktop: top bar, app windows, dock (Ken's decisions, 16 Oct 2026).
 *
 * It replaces the old page-with-a-nav-bar shell for teachers and students alike. Every
 * existing page now shows inside an app's window (`apps.ts` says which), rendered with
 * `<Routes location={win.loc}>` so each window has its own page while the screens
 * themselves are unchanged.
 *
 * **The URL is the front window's page**, kept in step in both directions:
 *
 * - The URL changes (a link, `navigate()`, Back, a bookmark): the app that owns the new page
 *   shows it, opening its window or bringing it to the front.
 * - The person brings another window forward, closes or minimises one: the URL becomes the
 *   new front window's page.
 *
 * Window actions go through `act`, which runs the reducer synchronously and navigates from
 * the result — never from an effect watching the windows, which would race the URL effect
 * and bounce the browser between two pages.
 *
 * Teachers' layouts are saved to their account (`/me/desktop`) and come back on any laptop.
 * Students' windows are fixed full screen, never saved, and only the front window (or the
 * layout it belongs to) is mounted: a child's editor streams to the live view, and two of
 * them mounted at once would both claim to be what the child is looking at.
 */

import './desktop.css'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Routes, useLocation, useNavigate } from 'react-router'
import { Search as SearchIcon } from 'lucide-react'
import { CupMark, Lockup } from '../components/Brand'
import { Button } from '../components/Button'
import { Spinner } from '../components/Spinner'
import type { Schemas } from '../lib/api'
import { api } from '../lib/api'
import { useClasses, useSavedDesktop } from '../lib/queries'
import { appDef, appFor, appsFor, classOf, deskPath, fillsWindow } from './apps'
import type { AppId, Ctx, Role } from './apps'
import { DeskContext } from './context'
import { Menu } from './Menu'
import type { MenuItem } from './Menu'
import { SearchPalette } from './Search'
import { Window } from './Window'
import { frontOf, reduce, sameLoc } from './windows'
import type { Action, Geom, Loc, Win } from './windows'

/** How long the exit animations run; a window settles after this even with motion off. */
const LEAVE_MS = 230
const SAVE_AFTER_MS = 800

interface Shared {
  /** The `<Route>`s every window resolves its page against. */
  pages: ReactNode
  /** "Ken" / "Aria K". */
  name: string
  /** The centre (teacher) or the class (student). */
  subtitle: string
  onSignOut: () => void
}

/* --- the two desktops: what each needs before the windows can be laid out ------------- */

export function TeacherDesktop({ isOwner, ...shared }: Shared & { isOwner: boolean }) {
  const classes = useClasses()
  const saved = useSavedDesktop(true)
  if (classes.isPending || saved.isPending) {
    return (
      <div className="flex h-dvh items-center justify-center bg-cream">
        <Spinner label="Opening your desktop" />
      </div>
    )
  }
  return (
    <DesktopCore
      {...shared}
      role="teacher"
      isOwner={isOwner}
      classes={(classes.data ?? []).filter((c) => c.status === 'active')}
      saved={saved.data?.saved ? saved.data : null}
      locked={false}
    />
  )
}

export function StudentDesktop({ locked, ...shared }: Shared & { locked: boolean }) {
  return <DesktopCore {...shared} role="student" isOwner={false} classes={[]} saved={null} locked={locked} />
}

/* --- the desktop itself ----------------------------------------------------------------- */

interface CoreProps extends Shared {
  role: Role
  isOwner: boolean
  classes: Schemas['ClassOut'][]
  saved: Schemas['DesktopOut'] | null
  /** A quiz is running: the quiz is the only window, with no dock and no menus. */
  locked: boolean
}

const href = (l: Loc) => `${l.pathname}${l.search}${l.hash}`

function fromPath(path: string): Loc {
  const url = new URL(path, 'http://desk.invalid')
  return { pathname: url.pathname, search: url.search, hash: url.hash }
}

function firstClass(classes: Schemas['ClassOut'][], saved: string | null | undefined, path: string) {
  const known = new Set(classes.map((c) => c.id))
  const fromUrl = classOf(path)
  if (fromUrl && known.has(fromUrl)) return fromUrl
  if (saved && known.has(saved)) return saved
  return (classes.find((c) => c.is_mine) ?? classes[0])?.id ?? null
}

function DesktopCore({ role, pages, name, subtitle, isOwner, classes, saved, locked, onSignOut }: CoreProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const teacher = role === 'teacher'
  const apps = appsFor(role)
  const desk = useRef<HTMLElement>(null)

  const [classId, setClassIdState] = useState<string | null>(() =>
    teacher ? firstClass(classes, saved?.class_id, location.pathname) : null,
  )
  const ctx: Ctx = useMemo(() => ({ classId, isOwner }), [classId, isOwner])

  // Windows live in state for rendering and in a ref for `act`, which must see the result
  // of the action it just ran in order to navigate from it.
  const [wins, setWinsState] = useState<Win[]>(() => initialWindows(role, saved, ctx))
  const winsRef = useRef(wins)
  const locRef = useRef(location)
  locRef.current = location
  const setWins = useCallback((next: Win[]) => {
    winsRef.current = next
    setWinsState(next)
  }, [])

  /** Run a window action; then, if the front window changed page, the URL follows it. */
  const act = useCallback(
    (action: Action, options: { follow?: boolean } = {}) => {
      // A child's windows are never dragged or resized; they may switch between a window
      // and full screen (18 Oct 2026).
      if (!teacher && action.type === 'place') return
      const next = reduce(winsRef.current, action)
      setWins(next)
      if (options.follow === false) return
      const front = frontOf(next)
      const here = locRef.current
      if (front && !sameLoc(front.loc, here)) navigate(href(front.loc), { state: front.loc.state })
      else if (!front && appFor(role, here.pathname)) navigate(deskPath(role), { replace: true })
    },
    [navigate, role, setWins, teacher],
  )

  // Where the next window to open should grow from: the dock icon that was pressed.
  const pendingOrigin = useRef<Partial<Record<AppId, { x: number; y: number }>>>({})

  /* The URL changed: show the page in the app that owns it. */
  useEffect(() => {
    const app = appFor(role, location.pathname)
    if (!app) {
      // `/desk`, where sign-in lands: show whatever is in front.
      const front = frontOf(winsRef.current)
      if (front) navigate(href(front.loc), { replace: true, state: front.loc.state })
      return
    }
    const origin = pendingOrigin.current[app] ?? null
    delete pendingOrigin.current[app]
    act(
      {
        type: 'show',
        app,
        loc: { pathname: location.pathname, search: location.search, hash: location.hash, state: location.state },
        origin,
      },
      { follow: false },
    )
    const cls = teacher ? classOf(location.pathname) : null
    if (cls && cls !== classId && classes.some((c) => c.id === cls)) setClassIdState(cls)
    // Only a change of page matters here; `classId` and the rest are read, not watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, location.pathname, location.search])

  /* Exit animations: take the window out once it has played (or would have). */
  const leaving = wins.filter((w) => w.anim === 'min' || w.anim === 'close').map((w) => w.app)
  const leavingKey = leaving.join(',')
  useEffect(() => {
    if (!leavingKey) return
    const timer = setTimeout(() => {
      for (const app of leavingKey.split(',')) act({ type: 'settle', app: app as AppId }, { follow: false })
    }, LEAVE_MS)
    return () => clearTimeout(timer)
  }, [leavingKey, act])

  /* Teachers: save the layout to their account, a moment after it stops changing. */
  useEffect(() => {
    if (!teacher) return
    const timer = setTimeout(() => {
      void api
        .saveDesktop({
          class_id: classId,
          windows: wins
            .filter((w) => w.anim !== 'close')
            .map((w) => ({
              app: w.app,
              path: href(w.loc).slice(0, 300),
              x: w.x,
              y: Math.min(Math.max(w.y, 0), 1),
              w: w.w,
              h: w.h,
              max: w.max,
              min: w.min || w.anim === 'min',
              z: w.z,
            })),
        })
        .catch(() => undefined)
    }, SAVE_AFTER_MS)
    return () => clearTimeout(timer)
  }, [teacher, wins, classId])

  /* Ctrl/⌘ K opens search. */
  const [searching, setSearching] = useState(false)
  useEffect(() => {
    if (locked) return
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearching(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [locked])

  function originFor(app: AppId, icon: HTMLElement) {
    const area = desk.current?.getBoundingClientRect()
    if (!area) return undefined
    const win = winsRef.current.find((w) => w.app === app)
    const g: Geom = !win || win.max ? { x: 0, y: 0, w: 1, h: 1 } : win
    const box = icon.getBoundingClientRect()
    return {
      x: Math.round(box.left + box.width / 2 - (area.left + g.x * area.width)),
      y: Math.round(box.top + box.height / 2 - (area.top + g.y * area.height)),
    }
  }

  function launch(app: AppId, icon: HTMLElement) {
    const origin = originFor(app, icon)
    const existing = winsRef.current.find((w) => w.app === app && w.anim !== 'close')
    if (existing) {
      act({ type: 'show', app, loc: existing.loc, origin })
      return
    }
    if (origin) pendingOrigin.current[app] = origin
    navigate(appDef(role, app)!.home(ctx))
  }

  function chooseClass(next: string) {
    if (next === classId) return
    const prev = classId
    setClassIdState(next)
    if (prev) act({ type: 'retarget', from: prev, to: next })
  }

  function layout(items: [AppId, string, Geom | null][]) {
    act({ type: 'layout', items: items.map(([app, path, geom]) => ({ app, loc: fromPath(path), geom })) })
  }

  /** The front window on the left, `app` showing `path` on the right, as one layout. */
  const openBeside = useCallback(
    (app: AppId, path: string) => {
      const front = frontOf(winsRef.current)
      const right = { x: 0.55, y: 0, w: 0.45, h: 1 }
      if (!front || front.app === app) return void act({ type: 'layout', items: [{ app, loc: fromPath(path), geom: null }] })
      act({
        type: 'layout',
        items: [
          { app: front.app, loc: front.loc, geom: { x: 0, y: 0, w: 0.55, h: 1 } },
          { app, loc: fromPath(path), geom: right },
        ],
      })
    },
    [act],
  )

  const layouts: MenuItem[] = teacher
    ? [
        {
          label: 'Live lesson',
          detail: 'Live, with My code beside it to show the class',
          onSelect: () =>
            layout([
              ['code', '/my-code', { x: 0.62, y: 0, w: 0.38, h: 1 }],
              ['live', appDef(role, 'live')!.home(ctx), { x: 0, y: 0, w: 0.62, h: 1 }],
            ]),
        },
        {
          label: 'Set homework',
          detail: 'A new homework beside the problem library',
          onSelect: () =>
            layout([
              ['library', '/problems', { x: 0.55, y: 0, w: 0.45, h: 1 }],
              ['work', classId ? `/classes/${classId}/homework/new` : '/classes', { x: 0, y: 0, w: 0.55, h: 1 }],
            ]),
        },
        {
          label: 'Mark and track',
          detail: 'Marking, with Progress beside it',
          onSelect: () =>
            layout([
              ['progress', appDef(role, 'progress')!.home(ctx), { x: 0.6, y: 0, w: 0.4, h: 1 }],
              ['marking', appDef(role, 'marking')!.home(ctx), { x: 0, y: 0, w: 0.6, h: 1 }],
            ]),
        },
      ]
    : [
        {
          label: 'Lesson and my code',
          detail: 'Today’s lesson beside your files',
          onSelect: () =>
            layout([
              ['code', '/work', { x: 0.4, y: 0, w: 0.6, h: 1 }],
              ['lessons', '/home', { x: 0, y: 0, w: 0.4, h: 1 }],
            ]),
        },
        {
          label: 'Homework and my code',
          detail: 'Your homework beside your files',
          onSelect: () =>
            layout([
              ['code', '/work', { x: 0.4, y: 0, w: 0.6, h: 1 }],
              ['work', '/my-work', { x: 0, y: 0, w: 0.4, h: 1 }],
            ]),
        },
      ]

  const front = frontOf(wins)
  const currentClass = classes.find((c) => c.id === classId) ?? null

  // Students mount only what they can see: the front window, or the layout it is part of.
  const mounted = (w: Win) =>
    teacher || (front !== null && (w.app === front.app || (front.group !== 0 && w.group === front.group)))

  const titleOf = (w: Win) => {
    const def = appDef(role, w.app)!
    return def.classScoped && currentClass && classOf(w.loc.pathname) === currentClass.id
      ? `${def.label} · ${currentClass.name}`
      : def.label
  }

  return (
    <DeskContext.Provider value={{ role, classId, isOwner, openBeside }}>
      <div className="flex h-dvh min-h-[600px] flex-col overflow-hidden bg-cream text-grape">
        <header className="relative z-[5000] flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-4">
          {teacher ? <Lockup size={26} /> : <CupMark size={28} />}
          <span className="mx-2 hidden h-6 w-px bg-line sm:block" />
          {teacher ? (
            <Menu
              label="Choose a class"
              items={[
                ...classes.map((c) => ({
                  label: c.name,
                  detail: c.term_label ?? undefined,
                  current: c.id === classId,
                  onSelect: () => chooseClass(c.id),
                })),
                { label: 'All classes…', onSelect: () => navigate('/classes') },
              ]}
            >
              <span className="font-normal text-muted">Class</span>
              <span className="max-w-48 truncate">{currentClass?.name ?? 'None yet'}</span>
            </Menu>
          ) : (
            <p className="truncate text-sm">
              <span className="font-medium">{name}</span>
              <span className="text-muted"> · {subtitle}</span>
            </p>
          )}
          {!locked ? (
            <Menu label="Layouts" items={layouts} width="w-80">
              Layouts
            </Menu>
          ) : null}
          <span className="flex-1" />
          {!locked ? (
            <button
              type="button"
              onClick={() => setSearching(true)}
              className="flex h-10 w-72 max-w-[30vw] items-center gap-2 rounded-full border border-line bg-cream px-3 text-sm text-muted hover:text-grape"
            >
              <SearchIcon size={16} aria-hidden="true" className="shrink-0" />
              <span className="flex-1 truncate text-left">Search</span>
              <kbd className="hidden rounded-md border border-line bg-surface px-1.5 text-xs sm:inline">Ctrl K</kbd>
            </button>
          ) : null}
          {teacher ? (
            <Menu
              label="Account"
              align="right"
              width="w-64"
              items={[{ label: 'Sign out', detail: `${name} · ${subtitle}`, onSelect: onSignOut }]}
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-grape text-sm font-semibold text-surface">
                {name.slice(0, 1).toUpperCase()}
              </span>
            </Menu>
          ) : (
            <Button variant="quiet" onClick={onSignOut}>
              Sign out
            </Button>
          )}
        </header>

        <main ref={desk} aria-label="Desktop" className="relative mx-1.5 min-h-0 flex-1">
          {!front ? <EmptyDesk teacher={teacher} layouts={layouts} /> : null}
          {wins.map((w) =>
            mounted(w) ? (
              <Window
                key={w.app}
                win={w}
                title={titleOf(w)}
                active={front?.app === w.app}
                arrange={teacher}
                tabs={(appDef(role, w.app)!.tabs?.(ctx) ?? []).map((tab) => ({
                  ...tab,
                  on: tab.active(w.loc.pathname, w.loc.search),
                }))}
                desk={desk}
                onFocus={() => {
                  if (front?.app !== w.app) act({ type: 'focus', app: w.app })
                }}
                onMinimise={() => act({ type: 'minimise', app: w.app })}
                onClose={() => act({ type: 'close', app: w.app })}
                onToggleMax={() => act({ type: 'toggleMax', app: w.app }, { follow: false })}
                onPlace={(geom, max) => act({ type: 'place', app: w.app, geom, max }, { follow: false })}
              >
                <Page loc={w.loc} pages={pages} />
              </Window>
            ) : null,
          )}
        </main>

        {!locked ? (
          <nav aria-label="Apps" className="relative z-[4000] flex shrink-0 justify-center px-4 pb-3 pt-2">
            <div className="flex max-w-full items-end gap-1 overflow-x-auto rounded-3xl border border-line bg-surface/95 px-3 pb-1.5 pt-2">
              {apps.map((app) => {
                const open = wins.some((w) => w.app === app.id && w.anim !== 'close')
                const Icon = app.icon
                return (
                  <button
                    key={app.id}
                    type="button"
                    aria-label={`Open ${app.label}`}
                    title={app.hint}
                    onClick={(event) => launch(app.id, event.currentTarget)}
                    className="group flex w-[74px] shrink-0 flex-col items-center gap-1 rounded-2xl py-0.5 focus-visible:outline-2 focus-visible:outline-grape-deep"
                  >
                    <span
                      className={`flex h-[52px] w-[52px] items-center justify-center rounded-2xl transition-transform group-hover:-translate-y-1 group-active:scale-95 motion-reduce:transition-none ${app.tile}`}
                    >
                      <Icon size={27} strokeWidth={1.9} aria-hidden="true" />
                    </span>
                    <span className="text-xs font-medium">{app.label}</span>
                    <span
                      aria-hidden="true"
                      className={`h-1 w-1 rounded-full ${open ? 'bg-grape' : 'bg-transparent'}`}
                    />
                  </button>
                )
              })}
            </div>
          </nav>
        ) : null}

        <SearchPalette
          open={searching}
          onClose={() => setSearching(false)}
          role={role}
          classId={classId}
          apps={apps.map((def) => ({ def, to: def.home(ctx) }))}
        />
      </div>
    </DeskContext.Provider>
  )
}

/**
 * One window's page. Memoised on its location, so dragging a window, or a change in
 * another one, never re-renders the page — an open editor least of all.
 */
const Page = memo(function Page({ loc, pages }: { loc: Loc; pages: ReactNode }) {
  return (
    <div
      className={
        fillsWindow(loc.pathname) ? 'flex min-h-0 flex-1 flex-col' : 'mx-auto w-full max-w-5xl px-6 py-8'
      }
    >
      <Routes location={{ pathname: loc.pathname, search: loc.search, hash: loc.hash, state: loc.state }}>
        {pages}
      </Routes>
    </div>
  )
})

function EmptyDesk({ teacher, layouts }: { teacher: boolean; layouts: MenuItem[] }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-4">
      <div className="flex w-[560px] max-w-full flex-col gap-5 rounded-3xl border border-line bg-surface p-8">
        <h1 className="font-display text-2xl font-semibold">
          {teacher ? 'Everything is closed' : 'Pick something to work on'}
        </h1>
        <div className="flex flex-col gap-2.5">
          {layouts.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={item.onSelect}
              className="flex min-h-14 flex-col items-start gap-0.5 rounded-2xl border border-line bg-cream px-4 py-3 text-left hover:border-grape"
            >
              <span className="font-semibold">{item.label}</span>
              <span className="text-sm text-muted">{item.detail}</span>
            </button>
          ))}
        </div>
        <p className="text-sm text-muted">Or open any app from the dock below.</p>
      </div>
    </div>
  )
}

/** The windows a desktop opens with: the teacher's saved layout, or Live; a child's none. */
function initialWindows(role: Role, saved: Schemas['DesktopOut'] | null, ctx: Ctx): Win[] {
  if (role !== 'teacher') return []
  const restored: Win[] = (saved?.windows ?? []).flatMap((w) => {
    const app = appFor(role, fromPath(w.path).pathname)
    if (!app || app !== w.app) return []
    return [
      {
        app,
        loc: fromPath(w.path),
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        max: w.max ?? false,
        min: w.min ?? false,
        z: w.z ?? 0,
        anim: null,
        origin: null,
        group: 0,
      },
    ]
  })
  if (restored.length) return restored
  // A teacher's desktop starts in Live (Ken's decision); with no class yet, in Classes.
  const start = ctx.classId ? appDef(role, 'live')! : appDef(role, 'classes')!
  return [
    {
      app: start.id,
      loc: fromPath(start.home(ctx)),
      x: 0.1,
      y: 0.05,
      w: 0.62,
      h: 0.8,
      max: true,
      min: false,
      z: 1,
      anim: 'open',
      origin: null,
      group: 0,
    },
  ]
}
