import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { server } from './server'

// Every test runs against the mock API. `onUnhandledRequest: 'error'` means a screen
// that calls an endpoint nobody stubbed fails loudly instead of hanging on a pending
// promise, which is the failure mode that wastes an afternoon.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
