/**
 * "Check & publish all": every draft in the bank, checked in this browser and published if
 * its solution passes.
 *
 * The bulk version of the editor's Check solution → Publish, built on the same
 * `verifyProblem` so the two cannot disagree. Sequential on purpose — one Python worker,
 * and a teacher watching the list fill in is better than a spinner over all of it.
 * Anything that does not pass is left a draft and listed with the reason.
 */

import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { Notice } from '../components/Notice'
import { api, type Schemas } from '../lib/api'
import { messageFor } from '../lib/errors'
import { keys } from '../lib/queries'
import { usePython } from '../runtime/usePython'
import { allLeavesPass, verifyProblem } from './verify'

interface Outcome {
  id: string
  title: string
  published: boolean
  reason?: string
}

export function PublishDrafts({ drafts }: { drafts: Schemas['ProblemSummaryOut'][] }) {
  const python = usePython()
  const client = useQueryClient()
  const [running, setRunning] = useState(false)
  const [outcomes, setOutcomes] = useState<Outcome[]>([])

  async function run() {
    setRunning(true)
    setOutcomes([])
    for (const draft of drafts) {
      let outcome: Outcome
      try {
        const problem = await api.readProblem(draft.id)
        if (problem.publish_problems.length) {
          outcome = { id: draft.id, title: draft.title, published: false, reason: problem.publish_problems[0] }
        } else if (problem.document.kind === 'mcq') {
          // Nothing to run: a complete multiple-choice question publishes as saved.
          await api.publishProblem(problem.id, problem.updated_at)
          outcome = { id: draft.id, title: draft.title, published: true }
        } else {
          const verification = await verifyProblem(python.check, problem)
          if (allLeavesPass(problem, verification)) {
            await api.publishProblem(problem.id, verification.updatedAt)
            outcome = { id: draft.id, title: draft.title, published: true }
          } else {
            outcome = {
              id: draft.id,
              title: draft.title,
              published: false,
              reason: 'The solution does not pass every check.',
            }
          }
        }
      } catch (error) {
        outcome = { id: draft.id, title: draft.title, published: false, reason: messageFor(error) }
      }
      setOutcomes((done) => [...done, outcome])
    }
    setRunning(false)
    await client.invalidateQueries({ queryKey: keys.allProblems })
  }

  if (drafts.length === 0) return null
  const unavailable = python.state.status === 'unsupported'

  return (
    <Card className="mb-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" disabled={running || unavailable} onClick={() => void run()}>
          {running
            ? `Checking ${outcomes.length + 1} of ${drafts.length}…`
            : `Check & publish ${drafts.length} draft${drafts.length === 1 ? '' : 's'}`}
        </Button>
        <span className="text-sm text-muted">
          {unavailable
            ? 'Python is not available in this browser.'
            : 'Each solution is run against its checks here; only the ones that pass are published.'}
        </span>
      </div>
      {outcomes.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1.5">
          {outcomes.map((outcome) => (
            <li key={outcome.id} className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={outcome.published ? 'good' : 'not-yet'}>
                {outcome.published ? 'Published' : 'Still a draft'}
              </Badge>
              <Link to={`/problems/${outcome.id}`} className="text-grape hover:text-grape-deep hover:underline">
                {outcome.title}
              </Link>
              {outcome.reason ? <span className="text-muted">— {outcome.reason}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!running && outcomes.length === drafts.length && outcomes.length > 0 ? (
        <div className="mt-3">
          <Notice tone={outcomes.every((o) => o.published) ? 'good' : 'not-yet'}>
            Published {outcomes.filter((o) => o.published).length} of {outcomes.length}.
          </Notice>
        </div>
      ) : null}
    </Card>
  )
}
