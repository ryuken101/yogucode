/**
 * A teacher's live view of one class: who is connected, what each child has open, what
 * just happened, and every open editor's text as a Yjs document rebuilt from the relay.
 *
 * The connection sends the teacher's Supabase token as its first message — a browser
 * WebSocket cannot carry an Authorization header — and sends **nothing else** until the
 * server answers with its snapshot. A help keystroke that raced ahead of the token would
 * be read as a failed sign-in and close the connection for good.
 *
 * Each document is replaced, not merged, when a child sends a full state: that means their
 * page reloaded and started a fresh document, and merging the old one into it would
 * duplicate their code.
 */

import { useCallback, useEffect, useState } from 'react'
import * as Y from 'yjs'
import { currentAccessToken } from '../lib/supabase'
import { LiveSocket, fromBase64, toBase64, type Message } from './socket'

const REMOTE = 'remote'
const MAX_RECENT = 50

export interface LiveStatus {
  kind: 'run' | 'check' | 'error' | 'paste' | 'hint' | string
  at?: number
  target?: string | null
  passed?: number
  total?: number
  text?: string
  chars?: number
  compile_error?: string | null
}

export interface LiveFocus {
  target: string
  kind: 'problem' | 'file'
  title: string
  mode?: string
  assignment_id?: string
}

export interface LiveStudent {
  studentId: string
  displayName: string
  online: boolean
  focus: LiveFocus | null
  recent: LiveStatus[]
  /** When this child last typed, by this browser's clock. */
  lastEditAt: number | null
}

export interface LiveDoc {
  doc: Y.Doc
  studentId: string
}

/**
 * Everything the view has learned, in one mutable object. Mutated by socket messages, read
 * by render; `version` changing is what tells React to read it again.
 */
class Store {
  readonly students = new Map<string, LiveStudent>()
  readonly docs = new Map<string, LiveDoc>()
  /** Each open editor's cursor, as its child last reported it. */
  readonly cursors = new Map<string, number>()
  socket: LiveSocket | null = null
  /** True from the server's snapshot until the connection drops: the teacher may send. */
  ready = false

  reset(socket: LiveSocket | null) {
    this.students.clear()
    this.docs.clear()
    this.cursors.clear()
    this.socket = socket
    this.ready = false
  }

  setReady(ready: boolean) {
    this.ready = ready
  }
}

export function useLiveClass(classId: string) {
  const [store] = useState(() => new Store())
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<'connecting' | 'live' | 'reconnecting' | 'refused'>('connecting')
  const bump = useCallback(() => setVersion((n) => n + 1), [])

  const newDoc = useCallback((target: string, studentId: string, updates: string[]) => {
    const doc = new Y.Doc()
    for (const update of updates) Y.applyUpdate(doc, fromBase64(update), REMOTE)
    // The teacher's own typing (help) goes back to the child through the relay.
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE && store.ready) {
        store.socket?.send({ type: 'doc', target, update: toBase64(update) })
      }
    })
    store.docs.set(target, { doc, studentId })
  }, [store])

  useEffect(() => {

    const upsert = (id: string, patch: Partial<LiveStudent>) => {
      const current = store.students.get(id) ?? {
        studentId: id,
        displayName: '',
        online: false,
        focus: null,
        recent: [],
        lastEditAt: null,
      }
      store.students.set(id, { ...current, ...patch })
    }

    const onMessage = (message: Message) => {
      switch (message.type) {
        case 'snapshot': {
          store.setReady(true)
          setState('live')
          for (const s of message.students as Record<string, unknown>[]) {
            upsert(String(s.student_id), {
              displayName: String(s.display_name),
              online: true,
              focus: (s.focus as LiveFocus | null) ?? null,
              recent: (s.recent as LiveStatus[]) ?? [],
            })
          }
          for (const d of message.docs as { target: string; student_id: string; updates: string[] }[]) {
            newDoc(d.target, d.student_id, d.updates)
          }
          break
        }
        case 'joined':
          upsert(String(message.student_id), {
            displayName: String(message.display_name),
            online: true,
            focus: (message.focus as LiveFocus | null) ?? null,
          })
          break
        case 'left':
          upsert(String(message.student_id), { online: false })
          break
        case 'focus':
          upsert(String(message.student_id), { focus: (message.focus as LiveFocus | null) ?? null })
          break
        case 'status': {
          const id = String(message.student_id)
          const recent = [...(store.students.get(id)?.recent ?? []), message.status as LiveStatus]
          upsert(id, { recent: recent.slice(-MAX_RECENT) })
          break
        }
        case 'doc': {
          const target = String(message.target)
          const studentId = String(message.student_id)
          const update = String(message.update)
          const existing = store.docs.get(target)
          if (message.full || !existing) newDoc(target, studentId, [update])
          else Y.applyUpdate(existing.doc, fromBase64(update), REMOTE)
          if (!message.by_teacher) upsert(studentId, { lastEditAt: Date.now() })
          break
        }
        case 'cursor':
          if (typeof message.offset === 'number') store.cursors.set(String(message.target), message.offset)
          break
        default:
          return
      }
      bump()
    }

    const live = new LiveSocket('/live/teacher', {
      queueWhileClosed: false,
      onOpen: (s) => {
        store.setReady(false)
        void currentAccessToken().then((token) =>
          s.send({ type: 'auth', token: token ?? '', class_id: classId }),
        )
      },
      onMessage,
      onClose: (final) => {
        store.setReady(false)
        setState(final ? 'refused' : 'reconnecting')
        if (!final) {
          for (const s of store.students.values()) s.online = false
          bump()
        }
      },
    })
    store.reset(live)
    return () => live.close()
  }, [classId, bump, newDoc, store])

  /** The teacher's cursor in a child's editor, or null to hide it when help ends. */
  const sendCursor = useCallback(
    (target: string, offset: number | null) => {
      if (store.ready && store.socket?.open) store.socket.send({ type: 'cursor', target, offset })
    },
    [store],
  )

  /**
   * Start or stop helping in a child's editor. Their editor is locked while anyone helps;
   * the server also unlocks it if this connection drops (Ken's decision, 11 Oct 2026).
   */
  const sendHelp = useCallback(
    (target: string, on: boolean) => {
      if (store.ready && store.socket?.open) store.socket.send({ type: 'help', target, on })
    },
    [store],
  )

  return {
    state,
    version,
    sendCursor,
    sendHelp,
    cursors: store.cursors,
    students: store.students,
    docs: store.docs,
  }
}
