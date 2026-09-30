/**
 * The editing surface.
 *
 * A boundary rather than a component: everything above it passes `value`, `onChange` and
 * the completions flag, and has no idea Monaco exists. That is what lets Phase 7 turn
 * completions off for quiz mode without touching anything that runs code, and what let the
 * runtime in Pass C be built and verified against a plain textarea first.
 *
 * `React.lazy` is the point. Monaco is about a megabyte, and only this route needs it.
 */

import { Suspense, lazy } from 'react'
import type { CodeSurfaceProps } from './MonacoSurface'

const MonacoSurface = lazy(() => import('./MonacoSurface'))

export function CodeSurface(props: CodeSurfaceProps) {
  return (
    <Suspense
      fallback={
        // Same surface and type as the editor, so the panel does not jump when Monaco
        // arrives — and the starting code stays readable while it loads.
        <pre className="h-full w-full overflow-hidden bg-ink-deep p-3 font-mono text-sm text-cream/60">
          {props.value}
        </pre>
      }
    >
      <MonacoSurface {...props} />
    </Suspense>
  )
}
