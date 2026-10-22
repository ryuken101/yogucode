/**
 * The landing page's hero: a calm Yogucode desktop (Ken's decision, 23 Oct 2026, after
 * sharyap.com). A column of icons on a cream screen, each opening one small window, and a
 * Hello window open from the start that carries the headline.
 *
 * It reuses the real desktop's window reducer (`desktop/windows.ts`) and frame
 * (`desktop/Window.tsx`), but not `Desktop.tsx`, which is tied to auth, routes and the
 * saved layout. Nothing is saved and the URL never changes.
 *
 * Below 760px the icons sit in a row and `desktop.css` makes every window fill the desk.
 */

import { Check, GraduationCap, Heart, LayoutGrid, Mail } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { CupMark } from '../components/Brand'
import { Window } from '../desktop/Window'
import { frontOf, reduce } from '../desktop/windows'
import type { Action, Geom, Win } from '../desktop/windows'
import '../desktop/desktop.css'
import { DEMO_HREF, HEADLINE, INSIDE, PARENT_POINTS, SUBLINE } from './copy'
import type { Point } from './copy'
import { LiveClassMock } from './Mocks'
import { useNarrow } from './useMedia'

type AppKey = 'hello' | 'how' | 'teachers' | 'parents' | 'demo'

interface HeroApp {
  label: string
  /** The desktop icon; Hello has none, it's the window you start with. */
  icon?: LucideIcon
  tile?: string
  /** Where it opens on a wide screen, as fractions of the desk. */
  geom: Geom
}

const APPS: Record<AppKey, HeroApp> = {
  hello: { label: 'Hello', geom: { x: 0.2, y: 0.08, w: 0.56, h: 0.8 } },
  how: { label: 'What’s inside', icon: LayoutGrid, tile: 'bg-lemon', geom: { x: 0.04, y: 0.06, w: 0.42, h: 0.62 } },
  teachers: { label: 'For teachers', icon: GraduationCap, tile: 'bg-grape-pale', geom: { x: 0.4, y: 0.04, w: 0.58, h: 0.9 } },
  parents: { label: 'For parents', icon: Heart, tile: 'bg-good/30', geom: { x: 0.14, y: 0.28, w: 0.42, h: 0.62 } },
  demo: { label: 'Book a demo', icon: Mail, tile: 'bg-strawberry/25', geom: { x: 0.5, y: 0.5, w: 0.4, h: 0.42 } },
}

const ICONS: AppKey[] = ['how', 'teachers', 'parents', 'demo']

/** The reducer wants a location; here a window has no URL of its own. */
const HERE = { pathname: '/', search: '', hash: '' }
const LEAVE_MS = 230

type HWin = Win<AppKey>

function placed(app: AppKey, z: number): HWin {
  return { app, loc: HERE, ...APPS[app].geom, max: false, min: false, z, anim: null, origin: null, group: 0 }
}

const ctaPrimary =
  'inline-flex items-center gap-2 rounded-2xl bg-grape px-5 py-3 font-medium text-surface hover:bg-grape-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-grape-deep'

export function HeroDesktop() {
  const narrow = useNarrow()
  const desk = useRef<HTMLDivElement>(null)
  const [wins, setWins] = useState<HWin[]>(() => [placed('hello', 1)])
  const front = frontOf(wins)

  const act = useCallback((action: Action<AppKey>) => setWins((ws) => reduce(ws, action)), [])

  const open = useCallback((app: AppKey, origin?: { x: number; y: number }) => {
    setWins((ws) => {
      if (ws.some((w) => w.app === app)) return reduce(ws, { type: 'show', app, loc: HERE, origin })
      const z = ws.reduce((m, w) => Math.max(m, w.z), 0) + 1
      return [...ws, { ...placed(app, z), anim: 'open', origin: origin ?? null }]
    })
  }, [])

  /* Exit animations: take the window out once it has played (or would have). */
  const leavingKey = wins
    .filter((w) => w.anim === 'min' || w.anim === 'close')
    .map((w) => w.app)
    .join(',')
  useEffect(() => {
    if (!leavingKey) return
    const timer = setTimeout(() => {
      for (const app of leavingKey.split(',')) act({ type: 'settle', app: app as AppKey })
    }, LEAVE_MS)
    return () => clearTimeout(timer)
  }, [leavingKey, act])

  /** The icon's centre in the window's own coordinates, for the grow animation. */
  function originFor(app: AppKey, icon: HTMLElement) {
    const area = desk.current?.getBoundingClientRect()
    if (!area) return undefined
    const win = wins.find((w) => w.app === app)
    const full = { x: 0, y: 0, w: 1, h: 1 }
    const g: Geom = narrow ? full : win ? (win.max ? full : win) : APPS[app].geom
    const box = icon.getBoundingClientRect()
    return {
      x: Math.round(box.left + box.width / 2 - (area.left + g.x * area.width)),
      y: Math.round(box.top + box.height / 2 - (area.top + g.y * area.height)),
    }
  }

  function content(app: AppKey): ReactNode {
    switch (app) {
      case 'hello':
        return <Hello onOpen={(a) => open(a)} />
      case 'how':
        return (
          <div className="flex h-full flex-col gap-3 overflow-auto bg-surface p-5 text-grape">
            <p className="text-sm text-muted">Everything a coding academy needs, in one place:</p>
            <ul className="flex flex-col gap-2">
              {INSIDE.map(([title]) => (
                <li key={title} className="flex items-center gap-2 font-medium">
                  <Check size={16} className="text-good-ink" aria-hidden="true" /> {title}
                </li>
              ))}
            </ul>
            <a href="#inside" className="mt-auto w-fit text-sm font-medium underline">
              More below ↓
            </a>
          </div>
        )
      case 'teachers':
        return (
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1 overflow-auto">
              <LiveClassMock />
            </div>
            <p className="border-t border-line px-4 py-2 text-sm text-muted">
              A pretend class. In a real one, this updates as children work.
            </p>
          </div>
        )
      case 'parents':
        return <Points points={PARENT_POINTS} />
      case 'demo':
        return (
          <div className="flex h-full flex-col items-start justify-center gap-4 p-5">
            <p className="text-grape">Tell us about your centre and we'll walk through a lesson together.</p>
            <a href={DEMO_HREF} className={ctaPrimary}>
              <Mail size={18} aria-hidden="true" /> Email us
            </a>
          </div>
        )
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 pb-3 min-[761px]:flex-row min-[761px]:gap-6 min-[761px]:px-6">
      <nav aria-label="Desktop icons" className="flex shrink-0 justify-center gap-1 min-[761px]:flex-col min-[761px]:justify-start min-[761px]:gap-3 min-[761px]:pt-4">
        {ICONS.map((app) => {
          const def = APPS[app]
          const Icon = def.icon!
          return (
            <button
              key={app}
              type="button"
              aria-label={`Open ${def.label}`}
              onClick={(event) => open(app, originFor(app, event.currentTarget))}
              className="group flex w-[76px] flex-col items-center gap-1 rounded-2xl py-1 text-grape focus-visible:outline-2 focus-visible:outline-grape-deep min-[761px]:w-[92px]"
            >
              <span
                className={`flex h-12 w-12 items-center justify-center rounded-2xl ring-1 ring-grape/10 transition-transform group-hover:-translate-y-0.5 group-active:scale-95 motion-reduce:transition-none min-[761px]:h-14 min-[761px]:w-14 ${def.tile}`}
              >
                <Icon size={24} strokeWidth={1.9} aria-hidden="true" />
              </span>
              <span className="text-xs font-medium">{def.label}</span>
            </button>
          )
        })}
      </nav>

      <div ref={desk} role="group" aria-label="Yogucode desktop" className="relative h-[520px] min-h-0 min-[761px]:h-auto min-[761px]:flex-1">
        {!front ? (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-muted">
            All tidy. Open something from the icons.
          </p>
        ) : null}
        {wins.map((w) => (
          <Window
            key={w.app}
            win={w}
            title={APPS[w.app].label}
            active={front?.app === w.app}
            arrange={!narrow}
            tabs={[]}
            desk={desk}
            onFocus={() => {
              if (front?.app !== w.app) act({ type: 'focus', app: w.app })
            }}
            onMinimise={() => act({ type: 'minimise', app: w.app })}
            onClose={() => act({ type: 'close', app: w.app })}
            onToggleMax={() => act({ type: 'toggleMax', app: w.app })}
            onPlace={(geom, max) => act({ type: 'place', app: w.app, geom, max })}
          >
            {content(w.app)}
          </Window>
        ))}
      </div>
    </div>
  )
}

function Hello({ onOpen }: { onOpen: (app: AppKey) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 overflow-auto bg-surface px-6 py-8 text-center text-grape">
      <CupMark size={96} />
      <h1 className="max-w-xl font-display text-3xl leading-tight font-semibold sm:text-4xl">
        {HEADLINE}
      </h1>
      <p className="max-w-md text-muted">{SUBLINE}</p>
      <div className="flex flex-wrap justify-center gap-3">
        <button type="button" onClick={() => onOpen('demo')} className={ctaPrimary}>
          Book a demo
        </button>
        <a
          href="#live"
          className="inline-flex items-center rounded-2xl px-4 py-3 font-medium text-grape hover:bg-grape-pale focus-visible:outline-2 focus-visible:outline-grape-deep"
        >
          See a live class ↓
        </a>
      </div>
    </div>
  )
}

function Points({ points }: { points: Point[] }) {
  return (
    <div className="flex h-full flex-col gap-3 overflow-auto bg-surface p-5 text-grape">
      <ul className="flex flex-col gap-3">
        {points.map(([title, body]) => (
          <li key={title}>
            <p className="font-semibold">{title}</p>
            <p className="text-sm text-muted">{body}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}
