/**
 * Where a child lands after signing in: today's ladder, and their files.
 *
 * The ladder is spec §3.3's answer to idle time — 1-dot problems first, a 2-dot, a 3-dot
 * extension — so nobody finishes with nothing to do. Every rung is visible from the start;
 * a child who is quick simply keeps climbing, without waiting to be handed the next sheet.
 *
 * Progress is sage when every check passes and sky while started. Never amber here: an
 * unfinished problem on a list is not a "not yet", it is just the next thing to do.
 */

import { Link } from 'react-router'
import { Badge } from '../components/Badge'
import { EmptyState } from '../components/Card'
import { Dots } from '../components/Dots'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { messageFor } from '../lib/errors'
import { useToday } from '../lib/queries'

export function StudentHome() {
  const today = useToday()

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      {today.isPending ? <Spinner label="Loading today’s lesson" /> : null}
      {today.error ? <Notice tone="system-error">{messageFor(today.error)}</Notice> : null}

      {today.data ? (
        <>
          <h1 className="mb-1 font-serif text-2xl text-ink">
            {today.data.lesson_title ?? 'Today'}
          </h1>
          <p className="mb-6 text-sm text-ink-soft">{today.data.class_name}</p>

          {today.data.problems.length === 0 || !today.data.assignment_id ? (
            <EmptyState title="Nothing set for today yet">
              Your teacher will put today’s problems here. Meanwhile, your files are in{' '}
              <Link to="/work" className="text-sky-deep underline">
                My files
              </Link>
              .
            </EmptyState>
          ) : (
            <ol className="flex flex-col gap-3">
              {today.data.problems.map((problem) => (
                <li key={problem.item_id}>
                  <Link
                    to={`/lesson/${today.data.assignment_id}/${problem.item_id}`}
                    className="flex items-center gap-4 rounded-xl bg-paper px-5 py-4 ring-1 ring-ink/10 hover:ring-sky"
                  >
                    <Dots value={problem.difficulty} />
                    <span className="font-medium text-ink">{problem.title}</span>
                    {problem.part_labels.length ? (
                      <span className="text-xs text-ink-soft">
                        {problem.part_labels.length} parts
                      </span>
                    ) : null}
                    <span className="ml-auto">
                      {problem.progress === 'passing' ? <Badge variant="good">All checks pass</Badge> : null}
                      {problem.progress === 'started' ? <Badge variant="active">Started</Badge> : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </>
      ) : null}
    </div>
  )
}
