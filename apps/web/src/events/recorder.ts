/**
 * The process trace, collected in the browser and sent in batches (spec §5.4).
 *
 * Three rules from the spec, each of which is a failure someone has had:
 *
 * - **Never POST per keystroke.** Twelve children typing on centre wifi would melt it.
 *   Events queue here and flush every few seconds.
 * - **Edits are diffs, not snapshots.** The editor reports what changed (`onEdit`), never
 *   the whole program.
 * - **A flush that might have failed is safe to resend.** Every event carries an id minted
 *   here (UUIDv7, time-ordered like the server's own ids), and the server skips ids it has
 *   seen. A network failure re-queues the batch; a refusal (4xx) drops it, because sending
 *   it again will not change the answer.
 *
 * One recorder per page load, shared by every editor on it: `editor_session_id` and `seq`
 * order a session's events for replay, independent of the child's clock.
 *
 * Phase 6 replaces the in-memory queue with IndexedDB so events survive a closed laptop.
 * Nothing about the server contract changes for that.
 */

import { useCallback, useEffect } from 'react'
import { api, type Schemas } from '../lib/api'
import { ApiError } from '../lib/errors'

export type EventType = Schemas['EventIn']['type']
export type Target = { attemptId: string } | { documentId: string }

export const FLUSH_INTERVAL_MS = 3_000
/** Server limit per request. */
const MAX_BATCH = 500
/** Past this, the oldest events are dropped rather than the page's memory growing forever. */
const MAX_QUEUED = 5_000
/** `fetch(keepalive)` bodies are capped at 64 KiB in browsers; stay under it. */
const KEEPALIVE_BUDGET = 60_000

/** A UUIDv7: 48 bits of milliseconds, then randomness, with the version and variant set. */
export function uuid7(now = Date.now()): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let ms = now
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256
    ms = Math.floor(ms / 256)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

type Sender = (events: Schemas['EventIn'][], keepalive: boolean) => Promise<unknown>

export class Recorder {
  readonly sessionId = uuid7()
  private seq = 0
  private queue: Schemas['EventIn'][] = []
  private inFlight = false
  private timer: ReturnType<typeof setInterval> | null = null

  private readonly send: Sender

  constructor(send: Sender = (events, keepalive) => api.recordEvents(events, keepalive)) {
    this.send = send
  }

  record(target: Target, type: EventType, payload: Record<string, unknown> = {}): void {
    this.queue.push({
      id: uuid7(),
      attempt_id: 'attemptId' in target ? target.attemptId : null,
      document_id: 'documentId' in target ? target.documentId : null,
      editor_session_id: this.sessionId,
      seq: this.seq++,
      type,
      payload,
      client_ts: new Date().toISOString(),
    })
    if (this.queue.length > MAX_QUEUED) this.queue.splice(0, this.queue.length - MAX_QUEUED)
  }

  get pending(): number {
    return this.queue.length
  }

  async flush(): Promise<void> {
    if (this.inFlight || this.queue.length === 0) return
    this.inFlight = true
    const batch = this.queue.splice(0, MAX_BATCH)
    try {
      await this.send(batch, false)
    } catch (error) {
      // Never reached the server, or the server fell over: try again next tick, ahead of
      // anything recorded since. A 4xx will not improve on a second asking — drop it.
      const transient = !(error instanceof ApiError) || error.status === 0 || error.status >= 500
      if (transient) this.queue.unshift(...batch)
    } finally {
      this.inFlight = false
    }
  }

  /**
   * The page is going away. Send what fits in one keepalive request and accept the rest
   * is lost — until Phase 6, when it would wait in IndexedDB instead.
   */
  flushOnExit(): void {
    if (this.queue.length === 0) return
    const batch: Schemas['EventIn'][] = []
    let size = 0
    for (const event of this.queue) {
      size += JSON.stringify(event).length
      if (size > KEEPALIVE_BUDGET || batch.length >= MAX_BATCH) break
      batch.push(event)
    }
    this.queue.splice(0, batch.length)
    void this.send(batch, true).catch(() => undefined)
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }
}

let shared: Recorder | null = null

/** The page's one recorder, started on first use. */
export function recorder(): Recorder {
  if (!shared) {
    shared = new Recorder()
    shared.start()
    window.addEventListener('pagehide', () => shared?.flushOnExit())
  }
  return shared
}

/**
 * `record(type, payload)` bound to one attempt or file. Null target records nothing —
 * the editor before its file has loaded.
 *
 * Leaving the page flushes on `pagehide`; leaving the *screen* (switching to another route)
 * flushes on unmount, so the last few seconds of a problem are not left waiting for a timer.
 */
export function useEventRecorder(target: Target | null) {
  const key = target ? ('attemptId' in target ? target.attemptId : target.documentId) : null
  const kind = target ? ('attemptId' in target ? 'attempt' : 'document') : null

  useEffect(() => () => void recorder().flush(), [])

  return useCallback(
    (type: EventType, payload: Record<string, unknown> = {}) => {
      if (!key || !kind) return
      recorder().record(kind === 'attempt' ? { attemptId: key } : { documentId: key }, type, payload)
    },
    [key, kind],
  )
}
