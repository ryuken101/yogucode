/**
 * The printable PIN slips.
 *
 * A route rather than a modal, because printing a modal is miserable and because the
 * browser's print dialog needs a page to point at.
 *
 * **The slips arrive in router state and are never refetched, because they cannot be.**
 * The API returns a PIN in plaintext exactly once and stores only an Argon2id hash, so
 * there is no endpoint that could answer "what were those again". A reload therefore
 * says so plainly instead of showing a spinner that will never resolve.
 */

import { Link, useLocation, useParams } from 'react-router'
import { CupMark } from '../components/Brand'
import { Button } from '../components/Button'
import { Card, PageHeader } from '../components/Card'
import { Notice } from '../components/Notice'
import type { Schemas } from '../lib/api'

export interface SlipState {
  slips: Schemas['PinSlipOut'][]
  className: string
}

export function SlipSheet() {
  const host = window.location.host
  const { classId } = useParams<{ classId: string }>()
  const state = useLocation().state as SlipState | null

  if (!state?.slips?.length) {
    return (
      <>
        <PageHeader title="PIN slips" />
        <Card>
          <Notice tone="not-yet">
            These PINs can’t be shown again. They are stored as a one-way hash, so nobody
            — not even us — can read them back. Issue new ones if you need them.
          </Notice>
          <div className="mt-4">
            <Link to={`/classes/${classId}`} className="text-grape-deep underline">
              Back to the class
            </Link>
          </div>
        </Card>
      </>
    )
  }

  return (
    <>
      {/* print:hidden keeps the app chrome off the paper. */}
      <div className="print:hidden">
        <PageHeader title="PIN slips">
          <Button variant="secondary" onClick={() => window.print()}>
            Print
          </Button>
          <Link
            to={`/classes/${classId}`}
            className="rounded-lg px-4 py-2 text-sm text-muted hover:text-grape"
          >
            Done
          </Link>
        </PageHeader>
        <div className="mb-6">
          <Notice tone="not-yet">
            Print these now. Once you leave this page the PINs cannot be shown again —
            only replaced.
          </Notice>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 print:grid-cols-2 print:gap-2">
        {state.slips.map((slip) => (
          <div
            key={slip.student_id}
            className="rounded-2xl border-2 border-dashed border-grape/20 bg-surface p-4 print:break-inside-avoid"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="font-display font-semibold text-lg text-grape">{slip.display_name}</p>
              <CupMark size={28} />
            </div>
            <dl className="mt-2 text-sm text-grape">
              {/* The one thing a child is told to type (Ken's decision): the address. */}
              <div className="flex gap-2">
                <dt className="text-muted">Go to</dt>
                <dd className="font-mono">{host}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted">Class</dt>
                <dd className="font-mono">{state.className}</dd>
              </div>
              {/* Username + PIN is the whole login (Ken's decision, 11 Oct 2026). */}
              <div className="flex gap-2">
                <dt className="text-muted">Username</dt>
                <dd className="font-mono">{slip.username}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted">PIN</dt>
                <dd className="font-mono text-xl tracking-[0.3em]">{slip.pin}</dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
    </>
  )
}
