import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { server } from './server'

// Every test runs against the mock API. `onUnhandledRequest: 'error'` means a screen
// that calls an endpoint nobody stubbed fails loudly instead of hanging on a pending
// promise, which is the failure mode that wastes an afternoon.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// jsdom implements <dialog> but not showModal()/close(). `Dialog` uses the native element
// deliberately — the browser gives focus trapping, Escape, page inertness and the top
// layer for free, all of which are easy to get subtly wrong by hand and all of which
// matter to a teacher driving by keyboard in front of a class. So the gap is filled here
// rather than by making the component worse to suit the test environment.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
}
