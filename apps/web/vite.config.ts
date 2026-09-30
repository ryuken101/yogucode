/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
/**
 * Cross-origin isolation, which the Python runtime cannot work without.
 *
 * Pyodide's stdin callback is synchronous — the interpreter blocks waiting for a return
 * value — so an interactive `input()` from inside a Web Worker needs `Atomics.wait()` on a
 * `SharedArrayBuffer`. Interrupting a runaway `while` loop needs `setInterruptBuffer()`,
 * which needs the same thing. And `SharedArrayBuffer` is only available to a
 * cross-origin-isolated document.
 *
 * These are document headers, and this is a single-page app, so they apply to `/join` and
 * the teacher screens too. That is fine here: the fonts are system stacks, Monaco and
 * Pyodide are both served from our own origin, and Supabase is a CORS fetch plus a
 * full-page redirect. The one thing COOP would break is an OAuth *popup*, which this
 * product does not use.
 *
 * Vercel needs the same two headers at step 10, or the editor will refuse to run.
 */
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `vite preview` serves the built app and must isolate it too, or the production build
  // appears broken in exactly the place it is least expected.
  preview: { headers: ISOLATION_HEADERS },
  server: {
    headers: ISOLATION_HEADERS,
    /**
     * The API is proxied rather than called cross-origin, which is why `apps/api` has no
     * CORS middleware. One origin in the browser means no preflight, no
     * `allow_credentials` juggling, and the student's httpOnly session cookie works with
     * no special handling at all.
     *
     * In production the two really are different origins (Vercel and Fly), so CORS is a
     * genuine step 10 concern. `VITE_API_BASE_URL` makes that a config change rather than
     * a code change.
     */
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Files needing a different environment declare it themselves with a
    // `// @vitest-environment node` docblock. `environmentMatchGlobs` was tried here and
    // is silently ignored by Vitest 4 — the tests ran under jsdom and passed anyway, which
    // is the worst outcome available.
  },
})
