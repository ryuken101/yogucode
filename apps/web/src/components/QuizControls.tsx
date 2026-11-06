/**
 * Start and Stop, each behind a confirmation, because both act on a whole class at once
 * (Ken, 6 Nov 2026). The same two wherever a quiz can be started or stopped.
 */

import { useState } from 'react'
import { Button } from './Button'
import { Dialog } from './Dialog'
import { Notice } from './Notice'
import { messageFor } from '../lib/errors'
import { useStopQuiz } from '../lib/queries'

/** The confirmation alone, for a Stop chosen from a menu. */
export function StopQuizDialog({
  quiz,
  open,
  onClose,
}: {
  quiz: { id: string; class_id: string; title: string }
  open: boolean
  onClose: () => void
}) {
  const stop = useStopQuiz(quiz.class_id)
  return (
    <Dialog
      open={open}
      title="Stop the quiz for everyone?"
      onClose={onClose}
      confirm={{
        label: stop.isPending ? 'Stopping…' : 'Stop the quiz',
        disabled: stop.isPending,
        onConfirm: () => stop.mutate(quiz.id, { onSuccess: onClose }),
      }}
    >
      <p>“{quiz.title}” ends for the whole class now, and everyone’s work is handed in.</p>
      {stop.error ? (
        <div className="mt-3">
          <Notice tone="system-error">{messageFor(stop.error)}</Notice>
        </div>
      ) : null}
    </Dialog>
  )
}

export function StopQuizButton({
  quiz,
  className,
}: {
  quiz: { id: string; class_id: string; title: string }
  className?: string
}) {
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <Button variant="secondary" className={className} onClick={() => setConfirming(true)}>
        Stop the quiz
      </Button>
      <StopQuizDialog quiz={quiz} open={confirming} onClose={() => setConfirming(false)} />
    </>
  )
}

export function StartQuizDialog({
  title,
  minutes,
  open,
  busy,
  onClose,
  onStart,
}: {
  title: string
  minutes: number
  open: boolean
  busy: boolean
  onClose: () => void
  onStart: () => void
}) {
  return (
    <Dialog
      open={open}
      title="Start the quiz for everyone?"
      onClose={onClose}
      confirm={{ label: busy ? 'Starting…' : 'Start the quiz', disabled: busy, onConfirm: onStart }}
    >
      <p>
        “{title}” opens for the whole class straight away, with {minutes} minute{minutes === 1 ? '' : 's'} on the
        clock. Their other work closes until it ends.
      </p>
    </Dialog>
  )
}
