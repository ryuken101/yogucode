/**
 * The owner's Teachers page: invite, revoke an invite, remove a teacher (Ken's decisions,
 * 10 Oct 2026).
 *
 * Inviting sends no email — the owner tells the teacher and copies them the sign-up link.
 * Until the teacher signs up the invite shows here as "Invited — hasn't signed up yet".
 * Removing someone takes effect on their next click; it deletes nothing, and inviting the
 * same address again brings them back with their classes.
 *
 * Only the owner sees the nav link, and the API refuses everyone else (403), which this
 * page explains rather than showing an error.
 */

import { useState } from 'react'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card, PageHeader } from '../components/Card'
import { Dialog } from '../components/Dialog'
import { TextInput } from '../components/Field'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import type { Schemas } from '../lib/api'
import { ApiError, messageFor } from '../lib/errors'
import { useInviteTeacher, useRemoveTeacher, useRevokeInvite, useTeachers } from '../lib/queries'

const signUpLink = () => `${window.location.origin}/sign-up`

function CopyLink() {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="secondary"
      onClick={() => {
        void navigator.clipboard
          .writeText(signUpLink())
          .then(() => setCopied(true))
          .catch(() => setCopied(false))
      }}
    >
      {copied ? 'Copied' : 'Copy sign-up link'}
    </Button>
  )
}

export function Teachers() {
  const teachers = useTeachers()
  const invite = useInviteTeacher()
  const revoke = useRevokeInvite()
  const remove = useRemoveTeacher()
  const [email, setEmail] = useState('')
  const [invited, setInvited] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Schemas['TeacherRowOut'] | null>(null)

  if (teachers.isPending) return <Spinner label="Loading teachers" />
  if (teachers.error) {
    const forbidden = teachers.error instanceof ApiError && teachers.error.status === 403
    return (
      <>
        <PageHeader title="Teachers" />
        <Notice tone={forbidden ? 'not-yet' : 'system-error'}>
          {forbidden
            ? 'Only the centre’s owner can manage teachers.'
            : messageFor(teachers.error)}
        </Notice>
      </>
    )
  }

  async function submitInvite(event: React.FormEvent) {
    event.preventDefault()
    setInvited(null)
    const created = await invite.mutateAsync(email.trim()).catch(() => null)
    if (created) {
      setInvited(created.email)
      setEmail('')
    }
  }

  const { teachers: rows, invites } = teachers.data

  return (
    <>
      <PageHeader title="Teachers" />

      <Card className="mb-6">
        <h2 className="mb-1 text-lg text-grape">Invite a teacher</h2>
        <p className="mb-4 text-sm text-muted">
          Add their email here, then send them the sign-up link. Only invited emails can
          create an account.
        </p>
        <form onSubmit={submitInvite} className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <TextInput
              label="Their email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <Button type="submit" variant="primary" disabled={invite.isPending || !email.trim()}>
            {invite.isPending ? 'Inviting…' : 'Invite'}
          </Button>
        </form>
        {invite.error ? (
          <div className="mt-3">
            <Notice tone="not-yet">{messageFor(invite.error)}</Notice>
          </div>
        ) : null}
        {invited ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Notice tone="good">
              {invited} is invited. Send them {signUpLink()} — they sign up there with this
              email.
            </Notice>
            <CopyLink />
          </div>
        ) : null}
      </Card>

      {invites.length > 0 ? (
        <Card className="mb-6">
          <h2 className="mb-3 text-lg text-grape">Invited</h2>
          <ul className="divide-y divide-line">
            {invites.map((pending) => (
              <li key={pending.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="font-medium text-grape">{pending.email}</span>
                <Badge variant="not-yet">Invited — hasn’t signed up yet</Badge>
                <div className="ml-auto flex gap-2">
                  <CopyLink />
                  <Button
                    variant="quiet"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(pending.id)}
                  >
                    Cancel invite
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {revoke.error ? <Notice tone="system-error">{messageFor(revoke.error)}</Notice> : null}
        </Card>
      ) : null}

      <Card>
        <h2 className="mb-3 text-lg text-grape">Teachers here</h2>
        <ul className="divide-y divide-line">
          {rows.map((teacher) => (
            <li key={teacher.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="flex flex-col">
                <span className="font-medium text-grape">{teacher.display_name}</span>
                <span className="text-sm text-muted">{teacher.email}</span>
              </div>
              {teacher.role === 'owner' ? <Badge variant="active">Owner</Badge> : null}
              {teacher.is_you ? <Badge variant="muted">You</Badge> : null}
              {!teacher.is_you ? (
                <Button variant="quiet" className="ml-auto" onClick={() => setRemoving(teacher)}>
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {remove.error ? <Notice tone="system-error">{messageFor(remove.error)}</Notice> : null}
      </Card>

      <Dialog
        open={removing !== null}
        title={removing ? `Remove ${removing.display_name}?` : ''}
        onClose={() => setRemoving(null)}
        confirm={{
          label: 'Remove',
          disabled: remove.isPending,
          onConfirm: () => {
            if (!removing) return
            remove.mutate(removing.id, { onSuccess: () => setRemoving(null) })
          },
        }}
      >
        <p>
          They’ll be signed out on their next click and won’t be able to sign in. Their
          classes, homework and marking stay. You can invite them again any time to bring
          them back.
        </p>
      </Dialog>
    </>
  )
}
