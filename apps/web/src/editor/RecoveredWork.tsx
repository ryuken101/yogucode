/**
 * "This computer has work that didn't get saved" — typing from an earlier visit that never
 * reached the server (a dropped connection, a closed tab), kept by `useAutosave` in this
 * browser (17 Oct 2026). Bring it back, or keep what is saved. Not-yet, not an error:
 * nothing has been lost.
 */

import { Button } from '../components/Button'
import { Notice } from '../components/Notice'

export function RecoveredWork({ onRestore, onDiscard }: { onRestore: () => void; onDiscard: () => void }) {
  return (
    <Notice tone="not-yet">
      <span className="flex flex-wrap items-center gap-2">
        <span>This computer has some of your work that didn’t get saved last time.</span>
        <Button variant="secondary" onClick={onRestore}>
          Bring it back
        </Button>
        <Button variant="quiet" onClick={onDiscard}>
          Keep what’s saved
        </Button>
      </span>
    </Notice>
  )
}
