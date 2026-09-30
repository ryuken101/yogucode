/**
 * Saving a child's work without them ever thinking about it.
 *
 * There is no Save button, because a nine-year-old will not press one and product-spec
 * §3.1's promise is "no lost files between weeks" rather than "no lost files if you
 * remember". So the editor holds the text and this writes it behind them.
 *
 * Three properties, in the order they matter:
 *
 * 1. **Typing never waits on the network.** Monaco owns the text; this only observes it.
 *    A child on flaky centre wifi should lose a couple of seconds at worst and should
 *    never see a spinner between keystrokes.
 * 2. **A quiet editor writes nothing.** Reading your own file back should not save it.
 * 3. **Switching file or leaving flushes first**, or the last few seconds of work would be
 *    lost at exactly the moment a child thinks they are done.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSaveDocument } from '../lib/queries'

/** Long enough to coalesce a sentence of typing, short enough to lose almost nothing. */
export const AUTOSAVE_DELAY_MS = 2_000

export type SaveState = 'saved' | 'saving' | 'failed'

export function useAutosave(documentId: string | null) {
  const save = useSaveDocument()
  const [state, setState] = useState<SaveState>('saved')

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The text last known to be on the server, so an unchanged editor writes nothing. */
  const persisted = useRef<string | null>(null)
  const pending = useRef<string | null>(null)
  const activeId = useRef<string | null>(documentId)

  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const id = activeId.current
    const content = pending.current
    if (!id || content === null || content === persisted.current) return

    pending.current = null
    setState('saving')
    save.mutate(
      { documentId: id, content },
      {
        onSuccess: () => {
          persisted.current = content
          setState('saved')
        },
        // Deliberately not retried: the usual cause is a revoked or expired session, and
        // retrying would hide that behind a spinner while the child keeps typing into
        // something that cannot be saved. The editor says so instead.
        onError: () => setState('failed'),
      },
    )
  }, [save])

  /** Tell the hook what the server already has, when a file is opened or created. */
  const adopt = useCallback((documentId: string | null, content: string) => {
    activeId.current = documentId
    persisted.current = content
    pending.current = null
    setState('saved')
  }, [])

  const onChange = useCallback(
    (content: string) => {
      pending.current = content
      if (content === persisted.current) return
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(flush, AUTOSAVE_DELAY_MS)
    },
    [flush],
  )

  // Leaving the page mid-sentence should not cost the sentence. `pagehide` rather than
  // `beforeunload`, which is unreliable and shows a browser prompt nobody wants.
  useEffect(() => {
    const onHide = () => flush()
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      flush()
    }
  }, [flush])

  return { state, onChange, adopt, flush }
}
