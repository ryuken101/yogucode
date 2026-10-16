/**
 * Saving a child's work without them ever thinking about it.
 *
 * Saving never depends on a button, because a nine-year-old will not press one and
 * product-spec §3.1's promise is "no lost files between weeks" rather than "no lost files
 * if you remember". So the editor holds the text and this writes it behind them. Since 17
 * Oct 2026 there is a Save button and ⌘/Ctrl+S anyway (Ken): for reassurance, and for the
 * moment before closing the laptop. They call `save`, which is the same flush. The state
 * says honestly when there is typing not yet sent (`pending`), where it used to say
 * "Saved" through the two-second wait.
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

export type SaveState = 'saved' | 'pending' | 'saving' | 'failed'

/**
 * What actually writes. Defaults to saving a file; a problem attempt passes its own, so
 * attempts get the same debounce, flush-on-leave and failure behaviour as files rather
 * than a second, subtly different copy of it.
 */
export type Saver = (id: string, content: string) => Promise<unknown>

export function useAutosave(documentId: string | null, saver?: Saver) {
  const saveDocument = useSaveDocument()
  const saveDocumentAsync = saveDocument.mutateAsync
  // The newest saver, kept in a ref so `flush` stays stable and the pagehide listener is
  // never re-attached. Updated after render, not during it.
  const write = useRef<Saver>((id, content) => saveDocumentAsync({ documentId: id, content }))
  useEffect(() => {
    write.current = saver ?? ((id, content) => saveDocumentAsync({ documentId: id, content }))
  })
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
    write.current(id, content).then(
      () => {
        persisted.current = content
        setState('saved')
      },
      // Deliberately not retried: the usual cause is a revoked or expired session, and
      // retrying would hide that behind a spinner while the child keeps typing into
      // something that cannot be saved. The editor says so instead — and keeps the text
      // as unsent, so pressing Save tries again.
      () => {
        if (pending.current === null) pending.current = content
        setState('failed')
      },
    )
  }, [])

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
      if (content === persisted.current) {
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = null
        setState((now) => (now === 'pending' ? 'saved' : now))
        return
      }
      setState((now) => (now === 'saving' ? now : 'pending'))
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

  // ⌘/Ctrl+S saves wherever the focus is — the console, a button — and never opens the
  // browser's "Save page". Inside the editor Monaco takes the key first (`onSave`).
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        flush()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flush])

  return { state, onChange, adopt, flush, save: flush }
}
