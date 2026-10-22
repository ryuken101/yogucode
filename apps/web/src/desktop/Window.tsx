/**
 * One app window: title bar, tabs, the page, and — for teachers — drag, resize and snap.
 *
 * While a window is being dragged or resized its geometry lives here, in local state, and
 * only the final place goes to the desktop's reducer. Moving a window therefore re-renders
 * this frame and nothing else: the page inside is the same element throughout, so an open
 * editor is never re-rendered by the mouse.
 *
 * The front window is shown by its tinted title bar, not by a shadow (Ken's decision,
 * 16 Oct 2026). Students' windows cannot be dragged or resized. They open full screen,
 * and like everyone's they switch between a window and **Full screen** with the title-bar
 * button or a double-click (17–18 Oct 2026): without it, a child who picked a layout by
 * accident was stuck in half a window. Minimise is everyone's.
 */

import { Maximize2, Minimize2, Minus, X } from 'lucide-react'
import { useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react'
import { Link } from 'react-router'
import type { Tab } from './apps'
import { MIN_H, MIN_W, ZONES, zoneAt } from './windows'
import type { Geom, Win, Zone } from './windows'

interface Props {
  win: Win<string>
  title: string
  active: boolean
  /** Teachers may drag, resize and snap; students may not. Everyone toggles full screen. */
  arrange: boolean
  tabs: (Tab & { on: boolean })[]
  desk: RefObject<HTMLElement | null>
  onFocus: () => void
  onMinimise: () => void
  onClose: () => void
  onToggleMax: () => void
  onPlace: (geom: Geom, max: boolean) => void
  children: ReactNode
}

type Op =
  | { kind: 'move'; sx: number; sy: number; start: Geom; wasMax: boolean; moved: boolean; rect: DOMRect }
  | { kind: 'resize'; mode: 'right' | 'bottom' | 'corner'; sx: number; sy: number; start: Geom; rect: DOMRect }

const pct = (n: number) => `${n * 100}%`

export function Window({
  win,
  title,
  active,
  arrange,
  tabs,
  desk,
  onFocus,
  onMinimise,
  onClose,
  onToggleMax,
  onPlace,
  children,
}: Props) {
  const op = useRef<Op | null>(null)
  const [drag, setDrag] = useState<Geom | null>(null)
  const [zone, setZone] = useState<Zone | null>(null)

  const g: Geom = drag ?? (win.max ? ZONES.max : win)
  const floating = !win.max || drag !== null

  function begin(event: ReactPointerEvent<HTMLElement>, next: (rect: DOMRect) => Op) {
    if (!arrange || event.button !== 0 || !desk.current) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    op.current = next(desk.current.getBoundingClientRect())
  }

  function move(event: ReactPointerEvent<HTMLElement>) {
    const o = op.current
    if (!o) return
    const r = o.rect
    if (o.kind === 'move') {
      if (!o.moved) {
        if (Math.abs(event.clientX - o.sx) + Math.abs(event.clientY - o.sy) < 5) return
        o.moved = true
        if (o.wasMax) {
          // Pulling a full-screen window off the top: it becomes a window under the pointer.
          const w = 0.5
          const x = Math.min(Math.max((event.clientX - r.left) / r.width - w / 2, 0), 1 - w)
          o.start = { x, y: 0, w, h: 0.66 }
          o.sx = event.clientX
          o.sy = event.clientY
          o.wasMax = false
        }
      }
      const dx = (event.clientX - o.sx) / r.width
      const dy = (event.clientY - o.sy) / r.height
      setDrag({
        ...o.start,
        x: Math.min(Math.max(o.start.x + dx, -o.start.w + 0.1), 0.9),
        y: Math.min(Math.max(o.start.y + dy, 0), 0.92),
      })
      setZone(zoneAt(event.clientX, event.clientY, r))
    } else {
      const dx = (event.clientX - o.sx) / r.width
      const dy = (event.clientY - o.sy) / r.height
      const next = { ...o.start }
      if (o.mode !== 'bottom') next.w = Math.min(Math.max(o.start.w + dx, MIN_W), 1 - o.start.x)
      if (o.mode !== 'right') next.h = Math.min(Math.max(o.start.h + dy, MIN_H), 1 - o.start.y)
      setDrag(next)
    }
  }

  function end() {
    const o = op.current
    op.current = null
    if (!o) return
    if (drag) {
      if (o.kind === 'move' && zone) onPlace(zone === 'max' ? drag : ZONES[zone], zone === 'max')
      else onPlace(drag, false)
    }
    setDrag(null)
    setZone(null)
  }

  const resizeHandle = (mode: 'right' | 'bottom' | 'corner', className: string) => (
    <div
      aria-hidden="true"
      className={`absolute touch-none ${className}`}
      onPointerDown={(event) => {
        event.stopPropagation()
        begin(event, (rect) => ({ kind: 'resize', mode, sx: event.clientX, sy: event.clientY, start: g, rect }))
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    />
  )

  const snap = zone ? ZONES[zone] : null

  return (
    <>
      {snap ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute p-1.5"
          style={{ left: pct(snap.x), top: pct(snap.y), width: pct(snap.w), height: pct(snap.h), zIndex: win.z + 1000 }}
        >
          <div className="h-full w-full rounded-2xl border-2 border-dashed border-grape bg-grape-pale/70" />
        </div>
      ) : null}
      <section
        aria-label={title}
        className="yc-win absolute p-1.5"
        data-anim={win.anim ?? undefined}
        style={{
          left: pct(g.x),
          top: pct(g.y),
          width: pct(g.w),
          height: pct(g.h),
          zIndex: drag ? win.z + 1001 : win.z,
          display: win.min ? 'none' : undefined,
          transformOrigin: win.origin ? `${win.origin.x}px ${win.origin.y}px` : '50% 100%',
        }}
        onPointerDownCapture={onFocus}
      >
        <div className="relative flex h-full w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface">
          <div
            className={`flex h-11 shrink-0 select-none items-center gap-1 border-b border-line pl-4 pr-1.5 ${
              active ? 'bg-grape-pale text-grape' : 'bg-cream text-muted'
            } ${arrange ? 'cursor-grab touch-none active:cursor-grabbing' : ''}`}
            onPointerDown={(event) =>
              begin(event, (rect) => ({
                kind: 'move',
                sx: event.clientX,
                sy: event.clientY,
                start: { x: win.x, y: win.y, w: win.w, h: win.h },
                wasMax: win.max,
                moved: false,
                rect,
              }))
            }
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onDoubleClick={onToggleMax}
          >
            <h2 className="min-w-0 flex-1 truncate font-display text-sm font-semibold">{title}</h2>
            <TitleButton label={`Minimise ${title}`} onClick={onMinimise}>
              <Minus size={16} aria-hidden="true" />
            </TitleButton>
            <TitleButton label={floating ? 'Full screen' : 'Make it a window'} onClick={onToggleMax}>
              {floating ? <Maximize2 size={15} aria-hidden="true" /> : <Minimize2 size={15} aria-hidden="true" />}
            </TitleButton>
            <TitleButton label={`Close ${title}`} onClick={onClose}>
              <X size={16} aria-hidden="true" />
            </TitleButton>
          </div>

          {tabs.length > 1 ? (
            <nav aria-label={`${title} sections`} className="flex shrink-0 gap-1 border-b border-line bg-surface px-3 py-2">
              {tabs.map((tab) => (
                <Link
                  key={tab.label}
                  to={tab.to}
                  aria-current={tab.on ? 'page' : undefined}
                  className={`rounded-full px-3.5 py-1.5 text-sm font-medium ${
                    tab.on ? 'bg-grape text-surface' : 'text-muted hover:bg-cream hover:text-grape'
                  }`}
                >
                  {tab.label}
                </Link>
              ))}
            </nav>
          ) : null}

          <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>

          {arrange && floating ? (
            <>
              {resizeHandle('right', 'right-0 top-11 bottom-4 w-2 cursor-ew-resize')}
              {resizeHandle('bottom', 'bottom-0 left-0 right-4 h-2 cursor-ns-resize')}
              {resizeHandle('corner', 'bottom-0 right-0 h-4 w-4 cursor-nwse-resize')}
            </>
          ) : null}
        </div>
      </section>
    </>
  )
}

function TitleButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      // A press on a button must not start dragging the window it sits in.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-xl text-muted hover:bg-surface hover:text-grape focus-visible:outline-2 focus-visible:outline-grape-deep"
    >
      {children}
    </button>
  )
}
