/**
 * Tells the teacher when a child's Yogucode page is out of sight (Ken, 6 Nov 2026): another
 * tab, another app, or the window hidden. During a quiz it also goes on the record marking
 * shows (`quiz_sittings`); in a lesson it is only ever live.
 *
 * What a browser can tell: that this page lost sight or focus. Not where the child went, and
 * nothing at all about a second device. Clicking the address bar counts too, so a short
 * delay keeps brief blips off the teacher's screen.
 *
 * Returns a number that goes up each time the child comes back after being reported away
 * during a quiz, for the page's reminder.
 */

import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { studentLive } from './socket'

/** How long away before it is worth a teacher's attention. */
export const AWAY_DELAY_MS = 2_000

export function useAttentionReporter(quizId: string | null, enabled: boolean): number {
  const [returned, setReturned] = useState(0)
  const away = useRef(false)
  const quiz = useRef(quizId)

  // A quiz started while they were away: the record starts now.
  useEffect(() => {
    quiz.current = quizId
    if (quizId && away.current) void api.reportAway(quizId, true).catch(() => undefined)
  }, [quizId])

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | null = null

    const report = (now: boolean) => {
      away.current = now
      studentLive().setAway(now)
      if (quiz.current) {
        // Best effort: a lost report is a gap in a record, never a problem for the child.
        void api.reportAway(quiz.current, now).catch(() => undefined)
        if (!now) setReturned((n) => n + 1)
      }
    }

    const update = () => {
      const out = document.hidden || !document.hasFocus()
      if (out && !away.current) {
        timer ??= setTimeout(() => {
          timer = null
          report(true)
        }, AWAY_DELAY_MS)
      } else if (!out) {
        if (timer !== null) clearTimeout(timer)
        timer = null
        if (away.current) report(false)
      }
    }

    document.addEventListener('visibilitychange', update)
    window.addEventListener('blur', update)
    window.addEventListener('focus', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('blur', update)
      window.removeEventListener('focus', update)
      if (timer !== null) clearTimeout(timer)
    }
  }, [enabled])

  return returned
}
