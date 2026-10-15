/**
 * The desktop's windows, as plain data and a reducer (Ken's decision, 16 Oct 2026).
 *
 * One window per app. Each holds **its own location** — the page it is showing — and the
 * front window's location *is* the browser's URL (`Desktop.tsx` keeps the two in step), so
 * links, bookmarks and Back keep working. Geometry is a fraction of the desktop area, so a
 * layout saved on one laptop fits another screen.
 *
 * Kept free of React so the rules — what "front" means, how snapping lands, what a student
 * may not do — are tested directly (`windows.test.ts`).
 */

import type { AppId } from './apps'

export interface Loc {
  pathname: string
  search: string
  hash: string
  /** Router state, e.g. the PIN slips. Never saved: it may hold plaintext PINs. */
  state?: unknown
}

export interface Geom {
  x: number
  y: number
  w: number
  h: number
}

/** `open` grows out of the dock; `min` and `close` play before the window goes. */
export type Anim = 'open' | 'min' | 'close' | null

export interface Win extends Geom {
  app: AppId
  loc: Loc
  /** Filling the desktop. The geometry is kept for when it becomes a window again. */
  max: boolean
  /** Minimised: in the dock, still mounted, so an editor keeps its state. */
  min: boolean
  z: number
  anim: Anim
  /** Where `open` grows from — the dock icon — in the window's own coordinates (px). */
  origin: { x: number; y: number } | null
  /** Windows placed together by a layout. Students mount only the front window's group. */
  group: number
}

export type Zone = 'max' | 'left' | 'right' | 'tl' | 'tr' | 'bl' | 'br'

export const ZONES: Record<Zone, Geom> = {
  max: { x: 0, y: 0, w: 1, h: 1 },
  left: { x: 0, y: 0, w: 0.5, h: 1 },
  right: { x: 0.5, y: 0, w: 0.5, h: 1 },
  tl: { x: 0, y: 0, w: 0.5, h: 0.5 },
  tr: { x: 0.5, y: 0, w: 0.5, h: 0.5 },
  bl: { x: 0, y: 0.5, w: 0.5, h: 0.5 },
  br: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
}

export const MIN_W = 0.2
export const MIN_H = 0.22

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Which snap zone a pointer at (x, y) is over, if any. Edges snap to halves, the ends of
 * the side edges to quarters, the top edge to full screen — Windows Snap, near enough.
 */
export function zoneAt(x: number, y: number, r: Rect): Zone | null {
  const nearLeft = x - r.left < 20
  const nearRight = r.right - x < 20
  const nearTop = y - r.top < 14
  const band = 90
  if (nearLeft && y - r.top < band) return 'tl'
  if (nearLeft && r.bottom - y < band) return 'bl'
  if (nearRight && y - r.top < band) return 'tr'
  if (nearRight && r.bottom - y < band) return 'br'
  if (nearLeft) return 'left'
  if (nearRight) return 'right'
  if (nearTop) return 'max'
  return null
}

export function sameLoc(a: Loc, b: Loc): boolean {
  return a.pathname === b.pathname && a.search === b.search && a.hash === b.hash
}

/** The window the person is working in: on top, and not on its way out. */
export function frontOf(wins: Win[]): Win | null {
  let best: Win | null = null
  for (const w of wins) {
    if (w.min || w.anim === 'min' || w.anim === 'close') continue
    if (!best || w.z > best.z) best = w
  }
  return best
}

const topZ = (wins: Win[]) => wins.reduce((m, w) => Math.max(m, w.z), 0)

function cascade(count: number): Geom {
  const step = 0.03 * (count % 6)
  return { x: 0.1 + step, y: 0.05 + step, w: 0.62, h: 0.8 }
}

export type Action =
  /** The URL now shows `loc`, which belongs to `app`: show it there, in front. */
  | { type: 'show'; app: AppId; loc: Loc; origin?: { x: number; y: number } | null }
  | { type: 'focus'; app: AppId }
  | { type: 'minimise'; app: AppId }
  | { type: 'close'; app: AppId }
  /** An exit animation finished (or would have): take the window out. */
  | { type: 'settle'; app: AppId }
  | { type: 'toggleMax'; app: AppId }
  | { type: 'place'; app: AppId; geom: Geom; max?: boolean }
  /** Several windows arranged at once ("Layouts"); the rest are minimised, not closed. */
  | { type: 'layout'; items: { app: AppId; loc: Loc; geom: Geom | null }[] }
  | { type: 'restore'; wins: Win[] }
  /** The class switcher moved: point class pages at the new class. */
  | { type: 'retarget'; from: string; to: string }

export function reduce(wins: Win[], action: Action): Win[] {
  switch (action.type) {
    case 'show': {
      const z = topZ(wins) + 1
      const found = wins.find((w) => w.app === action.app)
      if (found) {
        const hidden = found.min || found.anim === 'min' || found.anim === 'close'
        return wins.map((w) =>
          w.app === action.app
            ? {
                ...w,
                loc: action.loc,
                z: hidden || w.z !== z - 1 ? z : w.z,
                min: false,
                anim: hidden ? 'open' : w.anim,
                origin: hidden ? (action.origin ?? w.origin) : w.origin,
              }
            : w,
        )
      }
      return [
        ...wins,
        {
          app: action.app,
          loc: action.loc,
          ...cascade(wins.length),
          max: true,
          min: false,
          z,
          anim: 'open',
          origin: action.origin ?? null,
          // Its own group: a window opened from the dock is not part of any layout.
          group: 0,
        },
      ]
    }
    case 'focus': {
      const z = topZ(wins) + 1
      const target = wins.find((w) => w.app === action.app)
      if (!target || (target.z === z - 1 && !target.min)) return wins
      return wins.map((w) =>
        w.app === action.app ? { ...w, z, min: false, anim: w.min ? 'open' : w.anim } : w,
      )
    }
    case 'minimise':
      return wins.map((w) => (w.app === action.app ? { ...w, anim: 'min' } : w))
    case 'close':
      return wins.map((w) => (w.app === action.app ? { ...w, anim: 'close' } : w))
    case 'settle':
      return wins.flatMap((w) => {
        if (w.app !== action.app) return [w]
        if (w.anim === 'close') return []
        if (w.anim === 'min') return [{ ...w, min: true, anim: null }]
        return [w]
      })
    case 'toggleMax':
      return wins.map((w) => (w.app === action.app ? { ...w, max: !w.max, anim: null } : w))
    case 'place':
      return wins.map((w) =>
        w.app === action.app
          ? { ...w, ...action.geom, max: action.max ?? false, anim: null }
          : w,
      )
    case 'layout': {
      let z = topZ(wins)
      const group = wins.reduce((m, w) => Math.max(m, w.group), 0) + 1
      const placed = new Map(action.items.map((item) => [item.app, item]))
      const kept = wins
        .filter((w) => !placed.has(w.app))
        .map((w) => (w.min ? w : { ...w, min: true, anim: null }))
      const arranged: Win[] = action.items.map((item) => {
        const existing = wins.find((w) => w.app === item.app)
        return {
          app: item.app,
          loc: item.loc,
          ...(item.geom ?? existing ?? cascade(0)),
          max: item.geom === null,
          min: false,
          z: ++z,
          anim: 'open',
          origin: null,
          group,
        }
      })
      return [...kept, ...arranged]
    }
    case 'restore':
      return action.wins
    case 'retarget': {
      const prefix = `/classes/${action.from}`
      return wins.map((w) =>
        w.loc.pathname === prefix || w.loc.pathname.startsWith(`${prefix}/`)
          ? { ...w, loc: { ...w.loc, pathname: `/classes/${action.to}${w.loc.pathname.slice(prefix.length)}`, state: undefined } }
          : w,
      )
    }
  }
}

/** Students' windows are fixed: they may open, focus, minimise and close, never arrange. */
export const ARRANGING: ReadonlySet<Action['type']> = new Set(['toggleMax', 'place'])
