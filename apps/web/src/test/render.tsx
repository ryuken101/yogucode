/**
 * Rendering a screen the way the app renders it: inside a query client and a router.
 *
 * The query client is built per test with retries off. `createQueryClient` retries
 * network-ish failures twice, which is right in the app and wrong in a test — it turns an
 * expected failure into a slow one and makes a genuine regression look like a timeout.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'

export function renderScreen(ui: ReactNode, { route = '/' }: { route?: string } = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  })
  return {
    user: userEvent.setup(),
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </QueryClientProvider>,
    ),
  }
}
