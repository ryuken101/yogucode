/**
 * The printable PIN slips.
 *
 * A route rather than a modal, because printing a modal is miserable and because the
 * browser's print dialog needs a page to point at.
 *
 * **The slips arrive in router state and are never refetched.** A sheet of every PIN at
 * once is not something to fetch back: Show PIN on the class page reveals one child's at a
 * time, each look audited (Ken's decision, 16 Oct 2026). A reload therefore says where to
 * look instead of showing a spinner that will never resolve.
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
  // The children's sign-in, not the bare address: since 22 Oct 2026 that is the public
  // landing page.
  const host = `${window.location.host}/join`
  const { classId } = useParams<{ classId: string }>()
  const state = useLocation().state as SlipState | null

  if (!state?.slips?.length) {
    return (
      <>
        <PageHeader title="PIN slips" />
        <Card>
          <Notice tone="not-yet">
            This sheet can’t be shown again. Use Show PIN on the class page to look up one
            student’s PIN, or issue new ones.
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
            Print these now. Once you leave this page, you can look up a PIN one student at
            a time with Show PIN on the class page.
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
