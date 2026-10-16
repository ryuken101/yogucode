/**
 * The Files app's clipboard (17 Oct 2026): what was cut or copied, until it is pasted.
 *
 * In memory, for this tab — not the system clipboard, which holds text, not files. A
 * module-level store rather than component state, so it survives the Files window
 * switching place (each place is a different page) and a paste can land in another one.
 */

import { useSyncExternalStore } from 'react'
import type { TreeItem } from '../lib/folderTree'
import type { Place } from './fileStore'

export interface Clip {
  mode: 'cut' | 'copy'
  place: Place
  items: (TreeItem & { name: string })[]
}

let current: Clip | null = null
const listeners = new Set<() => void>()

export function setClip(next: Clip | null) {
  current = next
  for (const listener of listeners) listener()
}

export function useClip(): Clip | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
  )
}
