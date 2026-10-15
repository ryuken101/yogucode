/**
 * A top-bar menu: a button and a panel of choices under it.
 *
 * Closes on a choice, on Escape, and on a press anywhere outside it. Choices are real
 * buttons, so the keyboard reaches them with Tab.
 */

import { ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export interface MenuItem {
  label: string
  detail?: string
  current?: boolean
  onSelect: () => void
}

export function Menu({
  label,
  children,
  items,
  align = 'left',
  width = 'w-72',
}: {
  /** The accessible name of the button. */
  label: string
  /** What the button shows. */
  children: ReactNode
  items: MenuItem[]
  align?: 'left' | 'right'
  width?: string
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function away(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-10 items-center gap-1.5 rounded-xl px-3 py-2 text-[15px] font-medium text-grape hover:bg-grape-pale focus-visible:outline-2 focus-visible:outline-grape-deep"
      >
        {children}
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="menu"
          className={`absolute top-12 z-50 ${align === 'right' ? 'right-0' : 'left-0'} ${width} rounded-2xl border border-line bg-surface p-1.5`}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
              className={`flex w-full flex-col items-start gap-0.5 rounded-xl px-3 py-2.5 text-left text-grape hover:bg-grape-pale ${
                item.current ? 'font-semibold' : ''
              }`}
            >
              <span className="text-[15px]">{item.label}</span>
              {item.detail ? <span className="text-sm font-normal text-muted">{item.detail}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
