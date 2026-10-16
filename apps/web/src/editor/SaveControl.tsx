/**
 * Save, and what the save is doing (Ken's decision, 17 Oct 2026).
 *
 * Work saves itself (`useAutosave`); this is the button for being sure, beside a label
 * that tells the truth: "Unsaved changes" while typing waits to be sent, "Saving…", then
 * "Saved". ⌘/Ctrl+S does the same. A failed save keeps its own system-error notice on the
 * page — that one is ours, not the child's.
 */

import { Button } from '../components/Button'
import type { SaveState } from './useAutosave'

const SHORTCUT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘S' : 'Ctrl+S'

const LABEL: Record<SaveState, string> = {
  saved: 'Saved',
  pending: 'Unsaved changes',
  saving: 'Saving…',
  failed: 'Not saved',
}

export function SaveControl({ state, onSave, className = '' }: { state: SaveState; onSave: () => void; className?: string }) {
  return (
    <span className={`flex items-center gap-2 ${className}`}>
      <span className="text-xs text-muted" aria-live="polite">
        {LABEL[state]}
      </span>
      <Button
        variant="secondary"
        onClick={onSave}
        disabled={state === 'saved' || state === 'saving'}
        title={`Save (${SHORTCUT})`}
      >
        Save
      </Button>
    </span>
  )
}
