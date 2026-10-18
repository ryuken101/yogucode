/**
 * What a page inside a window may want to know about the desktop around it: who is using
 * it, and — for a teacher — which class the top bar is on. The Files app lists that class's
 * children, for example. Outside a desktop (tests rendering one screen) it reads as a
 * teacher with no class chosen.
 */

import { createContext, useContext } from 'react'
import type { AppId, Role } from './apps'

export interface Desk {
  role: Role
  classId: string | null
  isOwner: boolean
  /**
   * Open `path` in `app` beside the front window, the two side by side (18 Oct 2026): a
   * problem's "Put it away in Files…" opens Files next to it. Does nothing off a desktop.
   */
  openBeside?: (app: AppId, path: string) => void
}

export const DeskContext = createContext<Desk>({ role: 'teacher', classId: null, isOwner: false })

export function useDesk(): Desk {
  return useContext(DeskContext)
}
