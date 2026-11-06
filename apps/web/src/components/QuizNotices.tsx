/**
 * The calm notices over a child's quiz: time running short, and that their teacher can see
 * they left the page. Never `not-yet` or `system-error`: nothing here is wrong. They fade by
 * themselves, so nothing has to be dismissed mid-question.
 */

import { useEffect, useRef, useState } from 'react'
import { Notice } from './Notice'

const WARN_AT_MINUTES = [5, 1]
const SHOW_MS = 10_000

export function QuizNotices({ endsAt, returned }: { endsAt: string; returned: number }) {
  const [message, setMessage] = useState<string | null>(null)
  const lastLeft = useRef<number | null>(null)

  const [seenReturns, setSeenReturns] = useState(returned)
  if (returned !== seenReturns) {
    setSeenReturns(returned)
    setMessage('Welcome back. Your teacher can see when you leave this page.')
  }

  useEffect(() => {
    const check = () => {
      const left = new Date(endsAt).getTime() - Date.now()
      const before = lastLeft.current
      lastLeft.current = left
      if (before === null) return // a quiz that started with less than this says nothing
      for (const minutes of WARN_AT_MINUTES) {
        const mark = minutes * 60_000
        // Near the mark: Stop jumps the clock to zero past every mark, and warns of nothing.
        if (before > mark && left <= mark && left > mark - 5_000) {
          setMessage(`${minutes} minute${minutes === 1 ? '' : 's'} left.`)
        }
      }
    }
    check()
    const timer = setInterval(check, 1_000)
    return () => clearInterval(timer)
  }, [endsAt])

  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setMessage(null), SHOW_MS)
    return () => clearTimeout(timer)
  }, [message])

  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-16 z-[6000] flex justify-center px-4">
      {message ? (
        <div className="pointer-events-auto rounded-2xl bg-surface shadow-lg">
          <Notice tone="info">{message}</Notice>
        </div>
      ) : null}
    </div>
  )
}
