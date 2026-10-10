/**
 * Make one editor live: its text is a shared Yjs document that streams to the teacher's
 * live view, keystroke by keystroke, and accepts the teacher's typing when they help.
 *
 * `target` names the editor to the server — `attempt:<id>` or `document:<id>` — and is
 * checked there against the signed-in child. The document is created fresh for each
 * target with the text the editor opened with; on (re)connect its full state is sent,
 * which resets the server's log for it.
 *
 * Returns `bind`, handed to the editor (`CodeSurface onModel`), and `isRemote`, true while
 * a teacher's edit is being written into the editor — so the event recorder can file it
 * as `teacher_edit` rather than as the child's own keystrokes.
 *
 * And `locked`: true while a teacher is helping in this editor (Ken's decision, 11 Oct
 * 2026). The page makes the editor read-only meanwhile, so the child watches instead of
 * typing over their teacher. The server unlocks it when the teacher stops or leaves.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { MonacoYBinding, type BindableModel } from './monacoBinding'
import { RemoteCaret } from './remoteCaret'
import { studentLive } from './socket'

const REMOTE = 'remote'

export function useLiveDoc(target: string | null, initialText: string | null) {
  // A new document per target. The initial text is read once, when the target first
  // appears — the editor owns the text after that, exactly as Monaco does.
  const doc = useMemo(() => {
    if (!target || initialText === null) return null
    const created = new Y.Doc()
    created.getText('code').insert(0, initialText)
    return created
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, initialText === null])

  const binding = useRef<MonacoYBinding | null>(null)
  const caret = useRef<RemoteCaret | null>(null)
  // Which target the lock belongs to, so switching files never carries a lock across.
  const [lockedTarget, setLockedTarget] = useState<string | null>(null)

  useEffect(() => {
    if (!doc || !target) return
    const live = studentLive()
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE) live.sendDoc(target, update)
    }
    doc.on('update', onUpdate)
    const unregister = live.addDoc(target, {
      sendFull: () => live.sendDoc(target, Y.encodeStateAsUpdate(doc), true),
      receive: (update) => Y.applyUpdate(doc, update, REMOTE),
      cursor: (offset) => caret.current?.show(offset),
      help: (on) => setLockedTarget(on ? target : null),
    })
    return () => {
      // Not destroyed: React's development mode mounts effects twice, and a destroyed doc
      // cannot be revived. Unhooked, it is simply garbage once the editor is gone.
      unregister()
      doc.off('update', onUpdate)
    }
  }, [doc, target])

  const bind = useCallback(
    (model: BindableModel & ConstructorParameters<typeof RemoteCaret>[0]) => {
      if (!doc) return undefined
      binding.current = new MonacoYBinding(doc.getText('code'), model)
      caret.current = new RemoteCaret(model, 'Your teacher')
      return () => {
        binding.current?.dispose()
        caret.current?.dispose()
        binding.current = null
        caret.current = null
      }
    },
    [doc],
  )

  const isRemote = useCallback(() => binding.current?.applyingRemote ?? false, [])

  const onCursor = useCallback(
    (offset: number) => {
      if (target) studentLive().sendCursor(target, offset)
    },
    [target],
  )

  return { bind, isRemote, onCursor, locked: target !== null && lockedTarget === target }
}
