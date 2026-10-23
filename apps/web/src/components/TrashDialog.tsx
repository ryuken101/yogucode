/**
 * Delete, as everywhere since 23 Oct 2026: into the Trash for 30 days, restorable until
 * then (`apps/api/src/app/trash.py`). The words say where it goes and for how long; the
 * button is the ordinary primary style, never red.
 */

import { Dialog } from './Dialog'
import { Notice } from './Notice'

export const TRASH_DAYS = 30

interface Props {
  open: boolean
  onClose: () => void
  /** What is being deleted, e.g. "Lists practice". */
  name: string
  /** Anything else worth knowing first, e.g. "Children’s answers go with it." */
  note?: string
  onConfirm: () => void
  busy?: boolean
  error?: string | null
}

export function TrashDialog({ open, onClose, name, note, onConfirm, busy = false, error = null }: Props) {
  return (
    <Dialog
      open={open}
      title={`Delete ${name}?`}
      onClose={onClose}
      confirm={{ label: 'Delete', disabled: busy, onConfirm }}
    >
      <p>
        It goes to the Trash (in Files). You can restore it from there for {TRASH_DAYS} days;
        after that it is deleted for good.
      </p>
      {note ? <p className="mt-2">{note}</p> : null}
      {error ? (
        <div className="mt-3">
          <Notice tone="not-yet">{error}</Notice>
        </div>
      ) : null}
    </Dialog>
  )
}
