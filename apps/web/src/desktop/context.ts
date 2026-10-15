/**
 * What a page inside a window may want to know about the desktop around it: who is using
 * it, and — for a teacher — which class the top bar is on. The Files app lists that class's
 * children, for example. Outside a desktop (tests rendering one screen) it reads as a
 * teacher with no class chosen.
 */

import { createContext, useContext } from 'react'
import type { Role } from './apps'

export interface Desk {
  role: Role
  classId: string | null
  isOwner: boolean
}

export const DeskContext = createContext<Desk>({ role: 'teacher', classId: null, isOwner: false })

export function useDesk(): Desk {
  return useContext(DeskContext)
}
