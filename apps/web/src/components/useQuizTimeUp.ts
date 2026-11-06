import { useEffect, useState } from 'react'
import { useActiveQuiz } from '../lib/queries'

/**
 * Whether this quiz's clock has reached 0:00: from this browser's clock, and from the
 * server moving the end forward (Stop). The work is handed in a few seconds later, so pages
 * lock and send what they have in that gap.
 */
export function useQuizTimeUp(assignmentId: string): boolean {
  const active = useActiveQuiz()
  const endsAt = active.data?.assignment_id === assignmentId ? active.data.ends_at : null
  const [upFor, setUpFor] = useState<string | null>(null)
  useEffect(() => {
    if (!endsAt) return
    const timer = setTimeout(() => setUpFor(endsAt), Math.max(0, new Date(endsAt).getTime() - Date.now()))
    return () => clearTimeout(timer)
  }, [endsAt])
  return endsAt !== null && upFor === endsAt
}
