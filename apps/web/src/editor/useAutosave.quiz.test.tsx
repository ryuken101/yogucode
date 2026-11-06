/**
 * Saving when it counts: steady typing can't put a save off forever (it cost 25 seconds of
 * a quiz, 6 Nov 2026), and work saves itself when the connection comes back, with no more
 * typing. A refusal from the server is still never retried: that means sign in again.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ApiError } from '../lib/errors'
import { AUTOSAVE_DELAY_MS, AUTOSAVE_MAX_WAIT_MS, useAutosave } from './useAutosave'

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

beforeEach(() => {
  vi.useFakeTimers()
  window.localStorage.clear()
})
afterEach(() => vi.useRealTimers())

function setUp(saver: (id: string, content: string) => Promise<unknown>) {
  const hook = renderHook(() => useAutosave('a1', saver), { wrapper })
  act(() => hook.result.current.adopt('a1', 'start'))
  return hook
}

test('steady typing, never pausing long enough, still saves', () => {
  const saver = vi.fn(() => Promise.resolve())
  const { result } = setUp(saver)
  const stepMs = AUTOSAVE_DELAY_MS / 2
  for (let typed = 0; typed < AUTOSAVE_MAX_WAIT_MS + stepMs; typed += stepMs) {
    act(() => {
      result.current.onChange(`start ${typed}`)
      vi.advanceTimersByTime(stepMs)
    })
  }
  expect(saver).toHaveBeenCalled()
})

test('a pause still saves after the usual delay', () => {
  const saver = vi.fn(() => Promise.resolve())
  const { result } = setUp(saver)
  act(() => result.current.onChange('typed'))
  act(() => {
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1)
  })
  expect(saver).not.toHaveBeenCalled()
  act(() => {
    vi.advanceTimersByTime(1)
  })
  expect(saver).toHaveBeenCalledWith('a1', 'typed')
})

test('no connection: it says so and saves by itself when the connection is back', async () => {
  let reachable = false
  const saver = vi.fn(() =>
    reachable ? Promise.resolve() : Promise.reject(new ApiError(0, 'Could not reach the server.')),
  )
  const { result } = setUp(saver)
  act(() => {
    result.current.onChange('typed offline')
    result.current.flush()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(result.current.state).toBe('offline')

  reachable = true
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(saver).toHaveBeenLastCalledWith('a1', 'typed offline')
  expect(result.current.state).toBe('saved')
})

test('coming back online saves straight away, without waiting for the next retry', async () => {
  let reachable = false
  const saver = vi.fn(() =>
    reachable ? Promise.resolve() : Promise.reject(new ApiError(0, 'Could not reach the server.')),
  )
  const { result } = setUp(saver)
  act(() => {
    result.current.onChange('typed offline')
    result.current.flush()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  reachable = true
  await act(async () => {
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(result.current.state).toBe('saved')
})

test('a refusal is not retried', async () => {
  const saver = vi.fn(() => Promise.reject(new ApiError(401, 'Signed out')))
  const { result } = setUp(saver)
  act(() => {
    result.current.onChange('typed')
    result.current.flush()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(result.current.state).toBe('failed')
  expect(saver).toHaveBeenCalledTimes(1)
})
