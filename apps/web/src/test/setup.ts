import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { markStudentTab } from '../lib/tabSession'
import { server } from './server'

// Every test runs against the mock API. `onUnhandledRequest: 'error'` means a screen
// that calls an endpoint nobody stubbed fails loudly instead of hanging on a pending
// promise, which is the failure mode that wastes an afternoon.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())

// Most tests show a child already signed in, which means "signed in from this tab". The
// tests for closing the tab (TabSession.test.tsx) clear the marker themselves.
// Guarded: this setup is shared with `*.node.test.ts`, which has no DOM or storage.
if (typeof window !== 'undefined') {
  beforeEach(() => {
    window.sessionStorage.clear()
    markStudentTab()
  })
}
afterAll(() => server.close())

// jsdom implements <dialog> but not showModal()/close(). `Dialog` uses the native element
// deliberately — the browser gives focus trapping, Escape, page inertness and the top
// layer for free, all of which are easy to get subtly wrong by hand and all of which
// matter to a teacher driving by keyboard in front of a class. So the gap is filled here
// rather than by making the component worse to suit the test environment.
// Guarded on the type existing: this setup file is shared with `*.node.test.ts`, which
// runs without a DOM at all.
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
}

// jsdom has no layout, so it implements no scrolling either. `Console` scrolls to the
// newest output, which is behaviour worth having in a browser and meaningless here — so
// the method is stubbed rather than the component being made to check for it.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {}
}
