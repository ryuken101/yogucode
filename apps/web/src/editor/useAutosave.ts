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
import { track } from './inflight'

/** Long enough to coalesce a sentence of typing, short enough to lose almost nothing. */
export const AUTOSAVE_DELAY_MS = 2_000

export type SaveState = 'saved' | 'pending' | 'saving' | 'failed'

/**
 * What actually writes. Defaults to saving a file; a problem attempt passes its own, so
 * attempts get the same debounce, flush-on-leave and failure behaviour as files rather
 * than a second, subtly different copy of it.
 */
export type Saver = (id: string, content: string) => Promise<unknown>

/**
 * Typing not yet on the server, kept in this browser too (17 Oct 2026), so a lost
 * connection or a closed tab costs nothing: reopening the work offers it back. Per viewer,
 * best effort — `localStorage` can be missing or full, and the server copy is always the
 * real one.
 */
const BACKUP_PREFIX = 'yogucode-unsaved:'

function readBackup(id: string): string | null {
  try {
    const raw = window.localStorage.getItem(BACKUP_PREFIX + id)
    return raw === null ? null : (JSON.parse(raw) as { content: string }).content
  } catch {
    return null
  }
}

function writeBackup(id: string, content: string | null) {
  try {
    if (content === null) window.localStorage.removeItem(BACKUP_PREFIX + id)
    else window.localStorage.setItem(BACKUP_PREFIX + id, JSON.stringify({ content, at: Date.now() }))
  } catch {
    // Private window or full storage: the server copy is still the real one.
  }
}

export function useAutosave(
  documentId: string | null,
  saver?: Saver,
  /** What ⌘/Ctrl+S does, when it is more than saving — a problem's first Save asks where. */
  onShortcut?: () => void,
) {
  const saveDocument = useSaveDocument()
  const saveDocumentAsync = saveDocument.mutateAsync
  // The newest saver, kept in a ref so `flush` stays stable and the pagehide listener is
  // never re-attached. Updated after render, not during it.
  const write = useRef<Saver>((id, content) => saveDocumentAsync({ documentId: id, content }))
  useEffect(() => {
    write.current = saver ?? ((id, content) => saveDocumentAsync({ documentId: id, content }))
  })
  const [state, setState] = useState<SaveState>('saved')
  /** Typing from an earlier visit that never reached the server, offered back on open. */
  const [recovered, setRecovered] = useState<string | null>(null)
  const shortcut = useRef(onShortcut)
  useEffect(() => {
    shortcut.current = onShortcut
  })

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
    const sent = write.current(id, content)
    track(sent)
    sent.then(
      () => {
        persisted.current = content
        // Typing since this save went is still waiting: say so, rather than "Saved".
        const waiting = pending.current !== null && pending.current !== content
        setState(waiting ? 'pending' : 'saved')
        if (!waiting) writeBackup(id, null)
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
    // The same file reporting what was just saved, while newer typing waits to go: keep
    // the typing. Clearing it here lost the last words typed during a save (17 Oct 2026).
    if (documentId !== null && documentId === activeId.current && pending.current !== null && pending.current !== content) {
      persisted.current = content
      return
    }
    activeId.current = documentId
    persisted.current = content
    pending.current = null
    setState('saved')
    const backup = documentId ? readBackup(documentId) : null
    if (backup !== null && backup === content && documentId) writeBackup(documentId, null)
    setRecovered(backup !== null && backup !== content ? backup : null)
  }, [])

  /** Throw away the recovered typing: the server's copy stays. */
  const discardRecovered = useCallback(() => {
    if (activeId.current) writeBackup(activeId.current, null)
    setRecovered(null)
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
      if (activeId.current) writeBackup(activeId.current, content)
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

  // Unsent work and a failed save: closing the tab now would lose it, so the browser asks.
  useEffect(() => {
    if (state !== 'failed') return
    const onLeave = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [state])

  // ⌘/Ctrl+S saves wherever the focus is — the console, a button — and never opens the
  // browser's "Save page". Inside the editor Monaco takes the key first (`onSave`).
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (shortcut.current) shortcut.current()
        else flush()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flush])

  /**
   * Take the recovered typing back: it becomes unsaved work, sent like any typing. Returns
   * it, for the page to put in the editor. The backup stays until the save succeeds.
   */
  const restoreRecovered = useCallback((): string | null => {
    const text = recovered
    if (text === null) return null
    setRecovered(null)
    onChange(text)
    return text
  }, [recovered, onChange])

  return { state, onChange, adopt, flush, save: flush, recovered, discardRecovered, restoreRecovered }
}
