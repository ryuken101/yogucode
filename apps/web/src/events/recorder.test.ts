/**
 * The recorder's contract with a flaky network: batch, keep order, resend what may not
 * have arrived, drop what was refused, and fit the exit flush inside a keepalive request.
 */

import { expect, test, vi } from 'vitest'
import type { Schemas } from '../lib/api'
import { ApiError } from '../lib/errors'
import { Recorder, uuid7 } from './recorder'

const FILE = { documentId: '018f0000-0000-7000-8000-000000000001' }

function recording() {
  const sent: { events: Schemas['EventIn'][]; keepalive: boolean }[] = []
  let fail: unknown = null
  const recorder = new Recorder(async (events, keepalive) => {
    if (fail) throw fail
    sent.push({ events, keepalive })
  })
  return { recorder, sent, failWith: (error: unknown) => (fail = error) }
}

test('events are batched, ordered, and carry their target', async () => {
  const { recorder, sent } = recording()
  recorder.record(FILE, 'edit', { changes: [] })
  recorder.record({ attemptId: '018f0000-0000-7000-8000-000000000002' }, 'run')
  expect(sent).toHaveLength(0)

  await recorder.flush()

  expect(sent).toHaveLength(1)
  const [edit, run] = sent[0]!.events
  expect([edit!.seq, run!.seq]).toEqual([0, 1])
  expect(edit!.document_id).toBe(FILE.documentId)
  expect(run!.attempt_id).toBe('018f0000-0000-7000-8000-000000000002')
  expect(edit!.editor_session_id).toBe(run!.editor_session_id)
})

test('a batch that may not have arrived is sent again, first', async () => {
  const { recorder, sent, failWith } = recording()
  recorder.record(FILE, 'edit')
  failWith(new ApiError(0, 'offline'))
  await recorder.flush()
  expect(recorder.pending).toBe(1)

  failWith(null)
  recorder.record(FILE, 'run')
  await recorder.flush()

  expect(sent[0]!.events.map((e) => e.type)).toEqual(['edit', 'run'])
  expect(recorder.pending).toBe(0)
})

test('a refused batch is dropped, not retried forever', async () => {
  const { recorder, failWith } = recording()
  recorder.record(FILE, 'edit')
  failWith(new ApiError(404, 'not found'))
  await recorder.flush()
  expect(recorder.pending).toBe(0)
})

test('the exit flush fits in one keepalive request', () => {
  const { recorder, sent } = recording()
  for (let n = 0; n < 200; n++) recorder.record(FILE, 'edit', { text: 'x'.repeat(1_000) })

  recorder.flushOnExit()

  expect(sent).toHaveLength(1)
  expect(sent[0]!.keepalive).toBe(true)
  expect(JSON.stringify(sent[0]!.events).length).toBeLessThan(64 * 1024)
  expect(recorder.pending).toBe(200 - sent[0]!.events.length)
})

test('ids are UUIDv7 and sort by time', () => {
  const early = uuid7(1_700_000_000_000)
  const late = uuid7(1_700_000_000_001)
  expect(early).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(early < late).toBe(true)
})

test('the timer flushes on its own', async () => {
  vi.useFakeTimers()
  const { recorder, sent } = recording()
  recorder.start()
  recorder.record(FILE, 'edit')
  await vi.advanceTimersByTimeAsync(3_000)
  recorder.stop()
  vi.useRealTimers()
  expect(sent).toHaveLength(1)
})
