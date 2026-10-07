/**
 * The live classroom's connections, from the browser's side (server: `routers/live.py`).
 *
 * `LiveSocket` is a WebSocket that reconnects on its own — centre wifi drops, laptops
 * sleep — with a growing pause between attempts, and gives up only when the server says
 * the problem is who you are (4401/4403/4404), since retrying will not change that.
 *
 * A child's page has **one** connection, shared by every editor on it (`studentLive`). On
 * every (re)connect each open editor sends its whole document again, which is how the
 * server's log is rebuilt after a restart or a dropped connection.
 */

export type Message = { type: string } & Record<string, unknown>

const TERMINAL_CODES = new Set([4401, 4403, 4404])
const MAX_QUEUE = 500

/** The ws:// or wss:// address of a live endpoint, through the same base as the REST API. */
export function liveUrl(path: string): string {
  const base = import.meta.env.VITE_API_BASE_URL ?? '/api'
  const url = new URL(`${base}${path}`, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

interface Options {
  /** Called on every successful (re)connect, before queued messages are flushed. */
  onOpen?: (socket: LiveSocket) => void
  onMessage: (message: Message) => void
  /** Called when the connection is lost; `final` when it will not be retried. */
  onClose?: (final: boolean, code: number) => void
  /**
   * Hold messages sent while disconnected and flush them on reconnect. Off for a teacher:
   * their first message must be the sign-in token, and a flushed keystroke would beat it.
   */
  queueWhileClosed?: boolean
}

export class LiveSocket {
  private ws: WebSocket | null = null
  private queue: string[] = []
  private retryMs = 1_000
  private closed = false
  private readonly path: string
  private readonly options: Options

  constructor(path: string, options: Options) {
    this.path = path
    this.options = options
    this.connect()
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  private connect(): void {
    const ws = new WebSocket(liveUrl(this.path))
    this.ws = ws
    ws.onopen = () => {
      this.retryMs = 1_000
      this.options.onOpen?.(this)
      const pending = this.queue
      this.queue = []
      for (const data of pending) ws.send(data)
    }
    ws.onmessage = (event) => {
      try {
        this.options.onMessage(JSON.parse(String(event.data)) as Message)
      } catch {
        // A malformed frame is ignored rather than tearing the connection down.
      }
    }
    ws.onclose = (event) => {
      const final = this.closed || TERMINAL_CODES.has(event.code)
      this.options.onClose?.(final, event.code)
      if (final) return
      setTimeout(() => !this.closed && this.connect(), this.retryMs)
      this.retryMs = Math.min(this.retryMs * 2, 15_000)
    }
  }

  /** Send now if connected; otherwise hold it (bounded) for the next connection. */
  send(message: Message): void {
    const data = JSON.stringify(message)
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data)
      return
    }
    if (this.options.queueWhileClosed === false) return
    this.queue.push(data)
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE)
  }

  close(): void {
    this.closed = true
    this.ws?.close()
  }
}

/* --- the child's one connection -------------------------------------------------------- */

type DocListener = {
  /** Send the whole document — on (re)connect, and when the server asks. */
  sendFull: () => void
  /** An update typed by someone else (a teacher helping). */
  receive: (update: Uint8Array) => void
  /** Where the helping teacher's cursor is; null when they stop. */
  cursor?: (offset: number | null) => void
}

type QuizListener = (message: Message) => void

class StudentLive {
  private readonly docs = new Map<string, DocListener>()
  private readonly quizListeners = new Set<QuizListener>()
  private focus: Message | null = null
  readonly socket: LiveSocket

  constructor() {
    this.socket = new LiveSocket('/live/student', {
      onOpen: (socket) => {
        if (this.focus) socket.send(this.focus)
        for (const listener of this.docs.values()) listener.sendFull()
      },
      onMessage: (message) => {
        const target = typeof message.target === 'string' ? message.target : null
        if (message.type === 'doc' && target && typeof message.update === 'string') {
          this.docs.get(target)?.receive(fromBase64(message.update))
        } else if (message.type === 'cursor' && target) {
          this.docs.get(target)?.cursor?.(typeof message.offset === 'number' ? message.offset : null)
        } else if (message.type === 'resync' && target) {
          this.docs.get(target)?.sendFull()
        } else if (
          message.type === 'quiz_started' ||
          message.type === 'quiz_ending' ||
          message.type === 'quiz_ended'
        ) {
          this.quizListeners.forEach((listener) => listener(message))
        }
      },
    })
  }

  /** Register an open editor. Returns the function that unregisters it. */
  addDoc(target: string, listener: DocListener): () => void {
    this.docs.set(target, listener)
    if (this.socket.open) listener.sendFull()
    return () => {
      if (this.docs.get(target) === listener) this.docs.delete(target)
    }
  }

  sendDoc(target: string, update: Uint8Array, full = false): void {
    this.socket.send({ type: 'doc', target, update: toBase64(update), full })
  }

  /** Where the child's cursor is — only matters while a teacher is helping, so not queued. */
  sendCursor(target: string, offset: number): void {
    if (this.socket.open) this.socket.send({ type: 'cursor', target, offset })
  }

  /** What the child has open now — shown on their teacher's tile. */
  setFocus(focus: Record<string, unknown> | null): void {
    this.focus = { type: 'focus', focus }
    this.socket.send(this.focus)
  }

  /** Something that happened — a run, a check, an error, a paste — for the stuck signals. */
  status(status: Record<string, unknown>): void {
    this.socket.send({ type: 'status', status: { ...status, at: Date.now() } })
  }

  onQuiz(listener: QuizListener): () => void {
    this.quizListeners.add(listener)
    return () => this.quizListeners.delete(listener)
  }
}

let shared: StudentLive | null = null

/** The page's one live connection, opened on first use. */
export function studentLive(): StudentLive {
  shared ??= new StudentLive()
  return shared
}

/** Close it — on sign-out, so the next child on this laptop starts a connection of their own. */
export function closeStudentLive(): void {
  shared?.socket.close()
  shared = null
}
