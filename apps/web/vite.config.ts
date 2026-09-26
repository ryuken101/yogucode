/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
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
  },
})
