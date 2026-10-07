/**
 * A quiz, from the child's side: the clock, the questions, and what happens at the end.
 *
 * While it runs this is the only page a child can reach (`RequireStudent` sends them
 * back here), and the countdown is the class's one clock. When time is up their work has
 * already been handed in — they do not press anything — and the page says so. Once the
 * teacher gives it back, the same page shows the feedback, read-only.
 */

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { Badge } from '../components/Badge'
import { Dots } from '../components/Dots'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { studentLive } from '../collab/socket'
import { timeLeft } from '../lib/dates'
import { messageFor } from '../lib/errors'
import { keys, useActiveQuiz, useSheet } from '../lib/queries'
import { Returned } from './HomeworkSheet'

export function QuizRunner() {
  const { assignmentId = '' } = useParams()
  const client = useQueryClient()
  const sheet = useSheet(assignmentId)
  const active = useActiveQuiz()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])

  // The end arrives as a push; refresh what the page knows when it does.
  useEffect(
    () =>
      studentLive().onQuiz(() => {
        void client.invalidateQueries({ queryKey: keys.activeQuiz })
        void client.invalidateQueries({ queryKey: keys.sheet(assignmentId) })
      }),
    [client, assignmentId],
  )

  if (sheet.isPending || active.isPending) return <Spinner label="Opening the quiz" />
  if (sheet.error) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <Notice tone="system-error">{messageFor(sheet.error)}</Notice>
      </div>
    )
  }

  const data = sheet.data
  const running = active.data?.assignment_id === assignmentId ? active.data : null
  const problems = [...new Map(data.leaves.map((leaf) => [leaf.problem_id, leaf])).values()]

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-8">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="font-serif text-2xl text-ink">{data.title}</h1>
        <Badge variant="muted">Quiz</Badge>
        {running ? (
          <span className="ml-auto font-mono text-2xl text-ink" aria-label="time left">
            {timeLeft(running.ends_at, now)}
          </span>
        ) : null}
      </div>

      {data.returned ? (
        <Returned sheet={data} />
      ) : running ? (
        <>
          <p className="text-sm text-ink-soft">
            Your answers save as you go and are handed in when the time is up.
          </p>
          <ol className="flex flex-col gap-2">
            {problems.map((leaf, index) => (
              <li key={leaf.problem_id}>
                <Link
                  to={`/lesson/${assignmentId}/${leaf.problem_id}`}
                  className="flex items-center gap-4 rounded-xl bg-paper px-5 py-4 ring-1 ring-ink/10 hover:ring-sky"
                >
                  <span className="w-6 text-ink-soft">{index + 1}.</span>
                  <Dots value={leaf.difficulty} />
                  <span className="font-medium text-ink">{leaf.title.replace(/ \([a-f]\)$/, '')}</span>
                  <span className="ml-auto">
                    {leaf.progress !== 'not_started' ? <Badge variant="active">Started</Badge> : null}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <Notice tone="good">Time’s up — your answers have been handed in.</Notice>
          <p className="text-sm text-ink-soft">Your teacher will give them back when they’ve looked at them.</p>
          <Link to="/home" className="text-sm text-sky-deep">
            ← Home
          </Link>
        </div>
      )}
    </div>
  )
}
