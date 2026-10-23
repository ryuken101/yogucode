/**
 * The child's live connection when the server signs them out (23 Oct 2026): it closes with
 * 4401, the page is told at once, and nothing tries to reconnect.
 */

import { afterEach, expect, test, vi } from 'vitest'
import { closeStudentLive, studentLive } from './socket'

class FakeWebSocket {
  static made: FakeWebSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  url: string
  constructor(url: string) {
    this.url = url
    FakeWebSocket.made.push(this)
  }
  send() {}
  close() {}
}

afterEach(() => {
  closeStudentLive()
  FakeWebSocket.made = []
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('a sign-out from the server tells the page, and does not reconnect', () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const signedOut = vi.fn()
  studentLive().onSignedOut(signedOut)
  expect(FakeWebSocket.made).toHaveLength(1)

  FakeWebSocket.made[0]!.onclose?.({ code: 4401 })
  expect(signedOut).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(60_000)
  expect(FakeWebSocket.made).toHaveLength(1)
})

test('a dropped connection is not a sign-out, and reconnects', () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const signedOut = vi.fn()
  studentLive().onSignedOut(signedOut)

  FakeWebSocket.made[0]!.onclose?.({ code: 1006 })
  vi.advanceTimersByTime(2_000)
  expect(signedOut).not.toHaveBeenCalled()
  expect(FakeWebSocket.made.length).toBeGreaterThan(1)
})
