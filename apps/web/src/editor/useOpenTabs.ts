/**
 * Which files are open as tabs, and which one is showing — for My files and My code.
 *
 * Since folders arrived (11 Oct 2026) the explorer lists every file, and the tab strip is
 * only the ones you have opened, as in VS Code. Closing a tab just closes it; deleting is
 * the explorer's job.
 *
 * The open set is pruned against the live file list on every render rather than in an
 * effect: a file archived by deleting its folder simply stops being a tab, and if it was
 * the one showing, the next open tab takes its place.
 */

import { useCallback, useState } from 'react'
import type { Schemas } from '../lib/api'

type Summary = Schemas['DocumentSummaryOut']

export function useOpenTabs(files: Summary[] | undefined, flush: () => void) {
  const [openIds, setOpenIds] = useState<string[]>([])
  const [chosen, setChosen] = useState<string | null>(null)

  const byId = new Map((files ?? []).map((file) => [file.id, file]))
  const tabs = openIds.flatMap((id) => {
    const file = byId.get(id)
    return file ? [file] : []
  })
  const activeId =
    chosen !== null && byId.has(chosen) ? chosen : (tabs[tabs.length - 1]?.id ?? null)

  const open = useCallback(
    (id: string) => {
      // Flush before leaving, or the last couple of seconds of typing vanish at exactly the
      // moment someone thinks they have finished with a file.
      flush()
      setOpenIds((ids) => (ids.includes(id) ? ids : [...ids, id]))
      setChosen(id)
    },
    [flush],
  )

  const close = useCallback(
    (id: string) => {
      if (id === activeId) flush()
      setOpenIds((ids) => ids.filter((other) => other !== id))
      if (id === activeId) {
        const rest = tabs.filter((tab) => tab.id !== id)
        setChosen(rest[rest.length - 1]?.id ?? null)
      }
    },
    [activeId, flush, tabs],
  )

  return { tabs, activeId, open, close, opened: openIds.length > 0 }
}
