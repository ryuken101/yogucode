/**
 * A modal, on the native <dialog> element.
 *
 * Native rather than hand-rolled because the browser already does focus trapping, the
 * Escape key, inertness of the page behind, and the top layer — all of which are easy to
 * get subtly wrong and all of which matter when a teacher is driving with a keyboard in
 * front of a class.
 */

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Button } from './Button'

interface Props {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  /** The action the dialog exists to confirm. Omit for an informational dialog. */
  confirm?: { label: string; onConfirm: () => void; disabled?: boolean }
}

export function Dialog({ open, title, onClose, children, confirm }: Props) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (open && !node.open) node.showModal()
    if (!open && node.open) node.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        // Escape. Let React own the open state rather than the DOM, or the two drift.
        event.preventDefault()
        onClose()
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl bg-paper p-0 text-ink backdrop:bg-ink/30"
    >
      <div className="p-5">
        <h2 className="font-serif text-xl text-ink">{title}</h2>
        <div className="mt-3 text-sm text-ink">{children}</div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          {confirm ? (
            <Button variant="primary" onClick={confirm.onConfirm} disabled={confirm.disabled}>
              {confirm.label}
            </Button>
          ) : null}
        </div>
      </div>
    </dialog>
  )
}
