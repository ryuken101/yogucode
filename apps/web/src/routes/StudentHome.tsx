/**
 * Where a child lands after signing in: their homework, today's ladder, and their files.
 *
 * Homework first when there is any still to do — at home that is why they opened the
 * laptop. Each card answers the three questions a child (or a parent) has: when is it due,
 * how far have I got, have I handed it in. Work that has come back says so.
 *
 * The ladder is spec §3.3's answer to idle time — 1-dot problems first, a 2-dot, a 3-dot
 * extension — so nobody finishes with nothing to do. Progress is sage when every check
 * passes and sky while started. Never amber here: an unfinished problem on a list is not
 * a "not yet", it is just the next thing to do.
 */

import { Link } from 'react-router'
import { Badge } from '../components/Badge'
import { EmptyState } from '../components/Card'
import { Dots } from '../components/Dots'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import type { Schemas } from '../lib/api'
import { formatDue, isPast } from '../lib/dates'
import { messageFor } from '../lib/errors'
import { useHome } from '../lib/queries'

function HomeworkCard({ card }: { card: Schemas['HomeworkCardOut'] }) {
  return (
    <Link
      to={`/homework/${card.assignment_id}`}
      className="flex flex-wrap items-center gap-3 rounded-xl bg-paper px-5 py-4 ring-1 ring-ink/10 hover:ring-sky"
    >
      <span className="font-medium text-ink">{card.title}</span>
      <span className="text-sm text-ink-soft">
        {card.returned ? 'Given back' : `Due ${formatDue(card.due_at)}`}
      </span>
      <span className="ml-auto flex items-center gap-2">
        {card.returned ? (
          <Badge variant="good">Feedback is back</Badge>
        ) : card.handed_in_at ? (
          card.changed_since_hand_in ? (
            <Badge variant="active">Changed since you handed in</Badge>
          ) : (
            <Badge variant="good">Handed in</Badge>
          )
        ) : (
          <>
            <span className="text-sm text-ink-soft">
              {card.started} of {card.problems} started
            </span>
            {/* Past due and not handed in: worth a nudge, never an alarm. */}
            {isPast(card.due_at) ? <Badge variant="not-yet">Past the due date</Badge> : null}
          </>
        )}
      </span>
    </Link>
  )
}

export function StudentHome() {
  const home = useHome()

  if (home.isPending) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <Spinner label="Loading" />
      </div>
    )
  }
  if (home.error) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <Notice tone="system-error">{messageFor(home.error)}</Notice>
      </div>
    )
  }

  const { today, homework } = home.data
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-8">
      {homework.length > 0 ? (
        <section>
          <h2 className="mb-3 font-serif text-xl text-ink">Homework</h2>
          <ul className="flex flex-col gap-2">
            {homework.map((card) => (
              <li key={card.assignment_id}>
                <HomeworkCard card={card} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h1 className="mb-1 font-serif text-2xl text-ink">{today.lesson_title ?? 'Today'}</h1>
        <p className="mb-4 text-sm text-ink-soft">{today.class_name}</p>

        {today.problems.length === 0 || !today.assignment_id ? (
          <EmptyState title="Nothing set for today yet">
            Your teacher will put today’s problems here. Meanwhile, your files are in{' '}
            <Link to="/work" className="text-sky-deep underline">
              My files
            </Link>
            .
          </EmptyState>
        ) : (
          <ol className="flex flex-col gap-3">
            {today.problems.map((problem) => (
              <li key={problem.item_id}>
                <Link
                  to={`/lesson/${today.assignment_id}/${problem.item_id}`}
                  className="flex items-center gap-4 rounded-xl bg-paper px-5 py-4 ring-1 ring-ink/10 hover:ring-sky"
                >
                  <Dots value={problem.difficulty} />
                  <span className="font-medium text-ink">{problem.title}</span>
                  {problem.part_labels.length ? (
                    <span className="text-xs text-ink-soft">{problem.part_labels.length} parts</span>
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
      </section>
    </div>
  )
}
