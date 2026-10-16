/**
 * A right-click menu, as in Finder or File Explorer (17 Oct 2026).
 *
 * Opens at the pointer — or, from the keyboard (the context-menu key, Shift+F10), at the
 * selected item — nudged back inside the viewport. Closes on a choice, on Escape, and on a
 * press anywhere outside it, as the top-bar `Menu` does. Arrow keys move between items;
 * the first is focused on opening, so the keyboard is never stranded.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface ContextItem {
  label: string
  /** Shown on the right, as a reminder: "⌘C". */
  shortcut?: string
  disabled?: boolean
  onSelect: () => void
}

/** A line between groups of items. */
export const SEPARATOR = 'separator' as const
export type ContextEntry = ContextItem | typeof SEPARATOR

interface Props {
  x: number
  y: number
  label: string
  entries: ContextEntry[]
  onClose: () => void
}

export function ContextMenu({ x, y, label, entries, onClose }: Props) {
  const root = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState({ x, y })

  // Kept on screen: a right-click near the bottom-right edge opens up and to the left.
  useLayoutEffect(() => {
    const box = root.current?.getBoundingClientRect()
    if (!box) return
    setAt({
      x: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - box.height - 4)),
    })
  }, [x, y])

  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    function away(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) onClose()
    }
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', key)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', key)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  function move(event: React.KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    buttons[(index + step + buttons.length) % buttons.length]?.focus()
  }

  return (
    <div
      ref={root}
      role="menu"
      aria-label={label}
      onKeyDown={move}
      onContextMenu={(event) => event.preventDefault()}
      style={{ left: at.x, top: at.y }}
      className="fixed z-50 min-w-52 rounded-xl bg-surface p-1 text-sm text-grape shadow-lg ring-1 ring-line"
    >
      {entries.map((entry, index) =>
        entry === SEPARATOR ? (
          <div key={index} role="separator" className="my-1 h-px bg-line" />
        ) : (
          <button
            key={entry.label}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => {
              onClose()
              entry.onSelect()
            }}
            className="flex w-full items-center justify-between gap-6 rounded-lg px-3 py-1.5 text-left hover:bg-grape-pale focus:bg-grape-pale focus:outline-none disabled:text-line disabled:hover:bg-transparent"
          >
            <span>{entry.label}</span>
            {entry.shortcut ? <span className="text-xs text-muted">{entry.shortcut}</span> : null}
          </button>
        ),
      )}
    </div>
  )
}
