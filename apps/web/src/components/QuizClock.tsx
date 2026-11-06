/**
 * The class's one quiz clock, in the child's top bar for as long as the quiz runs (6 Nov
 * 2026; it used to live on the pages, and a page without one had no clock). Nothing when the
 * quiz is not running.
 */

import { useEffect, useState } from 'react'
import { timeLeft } from '../lib/dates'
import { useActiveQuiz } from '../lib/queries'

export function QuizClock({ assignmentId, className = '' }: { assignmentId: string; className?: string }) {
  const active = useActiveQuiz()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  const running = active.data?.assignment_id === assignmentId ? active.data : null
  if (!running) return null
  return (
    <span className={`font-mono text-grape ${className}`} aria-label="time left">
      {timeLeft(running.ends_at, now)}
    </span>
  )
}
