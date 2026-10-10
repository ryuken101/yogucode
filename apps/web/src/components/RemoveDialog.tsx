/**
 * Remove a student from a class, or remove a class: **Archive** or **Delete entirely**
 * (Ken's decisions, 11 Oct 2026).
 *
 * Archive is the everyday choice and can be undone. Delete entirely cannot, so it is shown
 * only to the centre's owner (the server enforces the same) and asks for the name to be
 * typed. Per the palette rule there is no red anywhere: the words carry the warning, and
 * the button is the ordinary primary style.
 */

import { useState } from 'react'
import { Button } from './Button'
import { Dialog } from './Dialog'
import { TextInput } from './Field'
import { Notice } from './Notice'

interface Props {
  open: boolean
  onClose: () => void
  /** "Remove Aria K from this class?" */
  title: string
  /** The name that must be typed to delete entirely. */
  name: string
  isOwner: boolean
  /** What archiving does, in a sentence or two. */
  archiveText: string
  archiveLabel: string
  onArchive: () => void
  /** What deleting entirely removes, and what it keeps. */
  deleteText: string
  onDelete: (confirmName: string) => void
  busy?: boolean
  error?: string | null
}

const same = (a: string, b: string) =>
  a.split(/\s+/).join(' ').trim().toLowerCase() === b.split(/\s+/).join(' ').trim().toLowerCase()

export function RemoveDialog({
  open,
  onClose,
  title,
  name,
  isOwner,
  archiveText,
  archiveLabel,
  onArchive,
  deleteText,
  onDelete,
  busy = false,
  error = null,
}: Props) {
  const [step, setStep] = useState<'choose' | 'delete'>('choose')
  const [typed, setTyped] = useState('')

  function close() {
    setStep('choose')
    setTyped('')
    onClose()
  }

  if (step === 'delete') {
    return (
      <Dialog
        open={open}
        title={`Delete ${name} entirely?`}
        onClose={close}
        confirm={{
          label: 'Delete entirely',
          disabled: busy || !same(typed, name),
          onConfirm: () => onDelete(typed),
        }}
      >
        <p>{deleteText}</p>
        <p className="mt-2 font-medium">This can’t be undone.</p>
        <div className="mt-4">
          <TextInput
            label={`Type ${name} to confirm`}
            value={typed}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        {error ? (
          <div className="mt-3">
            <Notice tone="system-error">{error}</Notice>
          </div>
        ) : null}
      </Dialog>
    )
  }

  return (
    <Dialog
      open={open}
      title={title}
      onClose={close}
      confirm={{ label: archiveLabel, disabled: busy, onConfirm: onArchive }}
    >
      <p>{archiveText}</p>
      {isOwner ? (
        <div className="mt-4 rounded-2xl bg-cream px-4 py-3 ring-1 ring-line">
          <p className="text-sm">
            Or delete it all permanently — only you, as the centre’s owner, can do this.
          </p>
          <div className="mt-2">
            <Button variant="secondary" onClick={() => setStep('delete')}>
              Delete entirely…
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="mt-3">
          <Notice tone="system-error">{error}</Notice>
        </div>
      ) : null}
    </Dialog>
  )
}
