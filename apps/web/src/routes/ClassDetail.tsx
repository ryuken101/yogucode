/**
 * One class: who is in it, how they get in, and their PINs.
 *
 * This is the screen a teacher actually works from, so the three things they do on a
 * lesson night are all reachable without scrolling past anything else: read out the join
 * code, add the children who turned up, and reissue a PIN for whoever forgot theirs.
 */

import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card, EmptyState, PageHeader } from '../components/Card'
import { Dialog } from '../components/Dialog'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { messageFor } from '../lib/errors'
import {
  useClass,
  useIssuePins,
  useResetPin,
  useRevokeSessions,
  useRoster,
  useRotateJoinCode,
} from '../lib/queries'
import { BulkPasteDialog } from './BulkPasteDialog'
import type { SlipState } from './SlipSheet'

export function ClassDetail() {
  const { classId = '' } = useParams<{ classId: string }>()
  const navigate = useNavigate()
  const klass = useClass(classId)
  const roster = useRoster(classId)
  const rotate = useRotateJoinCode(classId)
  const issuePins = useIssuePins(classId)
  const resetPin = useResetPin(classId)
  const revoke = useRevokeSessions()

  const [pasteOpen, setPasteOpen] = useState(false)
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [confirmReissue, setConfirmReissue] = useState(false)
  const [kicked, setKicked] = useState<string | null>(null)

  function goToSlips(slips: SlipState['slips']) {
    navigate(`/classes/${classId}/slips`, {
      state: {
        slips,
        className: klass.data?.name ?? '',
        joinCode: klass.data?.join_code ?? null,
      } satisfies SlipState,
    })
  }

  if (klass.isPending) return <Spinner label="Loading class" />
  if (klass.error) return <Notice tone="system-error">{messageFor(klass.error)}</Notice>

  const withoutPins = roster.data?.length ?? 0

  return (
    <>
      <PageHeader title={klass.data.name}>
        <Button variant="secondary" onClick={() => setPasteOpen(true)}>
          Add students
        </Button>
      </PageHeader>

      <Card className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium text-ink-soft">Join code</h2>
            {klass.data.join_code ? (
              <p className="font-mono text-3xl tracking-[0.35em] text-ink">
                {klass.data.join_code}
              </p>
            ) : (
              <p className="text-sm text-ink-soft">
                This class has no code yet. Create one to let students join.
              </p>
            )}
          </div>
          <Button
            variant="secondary"
            onClick={() => setConfirmRotate(true)}
            disabled={rotate.isPending}
          >
            {klass.data.join_code ? 'New code' : 'Create code'}
          </Button>
        </div>
        {rotate.error ? (
          <div className="mt-3">
            <Notice tone="system-error">{messageFor(rotate.error)}</Notice>
          </div>
        ) : null}
      </Card>

      <Card className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-serif text-lg text-ink">PINs</h2>
            <p className="text-sm text-ink-soft">
              Each student needs one to sign in. You’ll see them once, to print.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={issuePins.isPending || withoutPins === 0}
              onClick={() =>
                issuePins.mutate(false, {
                  onSuccess: (slips) =>
                    slips.length ? goToSlips(slips) : undefined,
                })
              }
            >
              {issuePins.isPending ? 'Issuing…' : 'Issue missing PINs'}
            </Button>
            <Button variant="quiet" onClick={() => setConfirmReissue(true)}>
              Reissue all
            </Button>
          </div>
        </div>
        {issuePins.isSuccess && issuePins.data.length === 0 ? (
          <div className="mt-3">
            <Notice tone="good">Everyone already has a PIN.</Notice>
          </div>
        ) : null}
        {issuePins.error ? (
          <div className="mt-3">
            <Notice tone="system-error">{messageFor(issuePins.error)}</Notice>
          </div>
        ) : null}
      </Card>

      <h2 className="mb-3 font-serif text-lg text-ink">Roster</h2>
      {roster.isPending ? <Spinner label="Loading roster" /> : null}
      {roster.error ? <Notice tone="system-error">{messageFor(roster.error)}</Notice> : null}

      {roster.data && roster.data.length === 0 ? (
        <EmptyState title="Nobody in this class yet">
          Use “Add students” to paste the whole list at once.
        </EmptyState>
      ) : null}

      {roster.data && roster.data.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {roster.data.map((entry) => (
            <li
              key={entry.student_id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-paper px-5 py-3 ring-1 ring-ink/10"
            >
              <span className="font-medium text-ink">{entry.display_name}</span>
              <div className="flex items-center gap-2">
                {entry.student_status === 'archived' ? <Badge variant="muted">Archived</Badge> : null}
                <Button
                  variant="quiet"
                  disabled={resetPin.isPending}
                  onClick={() =>
                    resetPin.mutate(entry.student_id, {
                      onSuccess: (slip) => goToSlips([slip]),
                    })
                  }
                >
                  Reset PIN
                </Button>
                <Button
                  variant="quiet"
                  disabled={revoke.isPending}
                  onClick={() =>
                    revoke.mutate(entry.student_id, {
                      onSuccess: (result) =>
                        setKicked(
                          result.revoked
                            ? `${entry.display_name} has been signed out.`
                            : `${entry.display_name} was not signed in.`,
                        ),
                    })
                  }
                >
                  Sign out
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {kicked ? (
        <div className="mt-4">
          <Notice tone="good">{kicked}</Notice>
        </div>
      ) : null}

      <BulkPasteDialog classId={classId} open={pasteOpen} onClose={() => setPasteOpen(false)} />

      <Dialog
        open={confirmRotate}
        title="Give this class a new code?"
        onClose={() => setConfirmRotate(false)}
        confirm={{
          label: 'New code',
          onConfirm: () => {
            rotate.mutate()
            setConfirmRotate(false)
          },
        }}
      >
        The current code stops working straight away, so anyone part-way through joining
        will need the new one.
      </Dialog>

      <Dialog
        open={confirmReissue}
        title="Reissue every PIN?"
        onClose={() => setConfirmReissue(false)}
        confirm={{
          label: 'Reissue all',
          onConfirm: () => {
            setConfirmReissue(false)
            issuePins.mutate(true, { onSuccess: (slips) => goToSlips(slips) })
          },
        }}
      >
        Every student in this class gets a new PIN and their old one stops working. Use
        this when the slips have gone missing.
      </Dialog>
    </>
  )
}
