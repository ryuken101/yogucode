/**
 * Creating and looking after a child's account from the class page (Ken's decisions,
 * 11 Oct 2026): a name, a username (suggested, editable) and a 4-digit PIN (typed, or left
 * blank for a random one).
 *
 * A PIN is shown once — on the slip, right after it is set — because it is stored hashed
 * and cannot be read back. If a child forgets it, Change PIN sets a new one.
 */

import { useEffect, useState } from 'react'
import { Dialog } from '../components/Dialog'
import { TextInput } from '../components/Field'
import { Notice } from '../components/Notice'
import type { Schemas } from '../lib/api'
import { api } from '../lib/api'
import { ApiError, messageFor } from '../lib/errors'
import { useAddStudent, useChangeUsername, useSetPin } from '../lib/queries'

type Slip = Schemas['PinSlipOut']

const PIN_HINT = 'Leave blank for a random PIN.'

/** A clash's own suggestion ("how about aria.k2?") when the server offers one. */
function suggestionFrom(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  const match = /how about ([a-z0-9.]+)\?/.exec(error.message)
  return match?.[1] ?? null
}

/** Not-yet for things the teacher can fix (409 clash, 422 bad PIN/username); else ours. */
function tone(error: unknown): 'not-yet' | 'system-error' {
  return error instanceof ApiError && (error.status === 409 || error.status === 422)
    ? 'not-yet'
    : 'system-error'
}

export function AddStudentDialog({
  classId,
  open,
  onClose,
  onCreated,
}: {
  classId: string
  open: boolean
  onClose: () => void
  onCreated: (slip: Slip) => void
}) {
  const add = useAddStudent(classId)
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [edited, setEdited] = useState(false)
  const [pin, setPin] = useState('')

  // Suggest a username as the name is typed, until the teacher edits it themselves.
  useEffect(() => {
    if (edited || !name.trim()) return
    let cancelled = false
    const timer = setTimeout(() => {
      api
        .suggestUsername(name.trim())
        .then((s) => !cancelled && setUsername(s.username))
        .catch(() => undefined)
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [name, edited])

  function reset() {
    setName('')
    setUsername('')
    setEdited(false)
    setPin('')
    add.reset()
  }

  const suggestion = suggestionFrom(add.error)

  return (
    <Dialog
      open={open}
      title="Add a student"
      onClose={() => {
        reset()
        onClose()
      }}
      confirm={{
        label: add.isPending ? 'Adding…' : 'Add student',
        disabled: add.isPending || !name.trim(),
        onConfirm: () =>
          add.mutate(
            {
              display_name: name.trim(),
              username: username.trim() || null,
              pin: pin.trim() || null,
            },
            {
              onSuccess: (slip) => {
                reset()
                onCreated(slip)
              },
            },
          ),
      }}
    >
      <div className="flex flex-col gap-3">
        <TextInput
          label="Name"
          placeholder="First name and last initial"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <TextInput
          label="Username"
          value={username}
          autoCapitalize="none"
          spellCheck={false}
          onChange={(event) => {
            setEdited(true)
            setUsername(event.target.value.toLowerCase())
          }}
        />
        <TextInput
          label="PIN (4 digits)"
          inputMode="numeric"
          maxLength={4}
          value={pin}
          placeholder="Random"
          onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
        />
        <p className="text-sm text-muted">{PIN_HINT}</p>
        {add.error ? (
          <Notice tone={tone(add.error)}>{messageFor(add.error)}</Notice>
        ) : null}
        {suggestion ? (
          <button
            type="button"
            className="self-start text-sm text-grape-deep underline"
            onClick={() => {
              setEdited(true)
              setUsername(suggestion)
              add.reset()
            }}
          >
            Use {suggestion}
          </button>
        ) : null}
      </div>
    </Dialog>
  )
}

export function ChangePinDialog({
  classId,
  student,
  onClose,
  onChanged,
}: {
  classId: string
  student: { id: string; name: string } | null
  onClose: () => void
  onChanged: (slip: Slip) => void
}) {
  const setPin = useSetPin(classId)
  const [pin, setValue] = useState('')

  return (
    <Dialog
      open={student !== null}
      title={student ? `Change ${student.name}’s PIN` : ''}
      onClose={() => {
        setValue('')
        setPin.reset()
        onClose()
      }}
      confirm={{
        label: setPin.isPending ? 'Saving…' : 'Set PIN',
        disabled: setPin.isPending || (pin.length > 0 && pin.length !== 4),
        onConfirm: () => {
          if (!student) return
          setPin.mutate(
            { studentId: student.id, pin },
            {
              onSuccess: (slip) => {
                setValue('')
                onChanged(slip)
              },
            },
          )
        },
      }}
    >
      <div className="flex flex-col gap-3">
        <p>
          The old PIN stops working straight away. You’ll see the new one once, to print or
          tell them.
        </p>
        <TextInput
          label="New PIN (4 digits)"
          inputMode="numeric"
          maxLength={4}
          value={pin}
          placeholder="Random"
          onChange={(event) => setValue(event.target.value.replace(/\D/g, ''))}
        />
        <p className="text-sm text-muted">{PIN_HINT}</p>
        {setPin.error ? (
          <Notice tone={tone(setPin.error)}>{messageFor(setPin.error)}</Notice>
        ) : null}
      </div>
    </Dialog>
  )
}

export function UsernameDialog({
  classId,
  student,
  onClose,
}: {
  classId: string
  student: { id: string; name: string; username: string } | null
  onClose: () => void
}) {
  const change = useChangeUsername(classId)
  const [value, setValue] = useState(student?.username ?? '')

  return (
    <Dialog
      open={student !== null}
      title={student ? `${student.name}’s username` : ''}
      onClose={() => {
        change.reset()
        onClose()
      }}
      confirm={{
        label: change.isPending ? 'Saving…' : 'Save',
        disabled: change.isPending || !value.trim(),
        onConfirm: () => {
          if (!student) return
          change.mutate(
            { studentId: student.id, username: value.trim() },
            { onSuccess: () => onClose() },
          )
        },
      }}
    >
      <div className="flex flex-col gap-3">
        <TextInput
          label="Username"
          value={value}
          autoCapitalize="none"
          spellCheck={false}
          onChange={(event) => setValue(event.target.value.toLowerCase())}
        />
        <p className="text-sm text-muted">
          Lower-case letters, numbers and dots. Their PIN stays the same.
        </p>
        {change.error ? (
          <Notice tone={tone(change.error)}>{messageFor(change.error)}</Notice>
        ) : null}
      </div>
    </Dialog>
  )
}
