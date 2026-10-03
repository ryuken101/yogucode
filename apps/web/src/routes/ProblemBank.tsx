/**
 * The problem bank: every problem at the centre, filterable by concept and difficulty.
 *
 * Shared by every teacher at the centre, like classes are — spec §7 is blunt that writing
 * 100+ good problems is the real bottleneck, and one shared bank is how other teachers'
 * work adds up instead of being written three times.
 */

import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { EmptyState, PageHeader } from '../components/Card'
import { Dots } from '../components/Dots'
import { Select, TextInput } from '../components/Field'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import type { ProblemFilters, Schemas } from '../lib/api'
import { messageFor } from '../lib/errors'
import { useConcepts, useProblems } from '../lib/queries'
import { PublishDrafts } from '../problems/PublishDrafts'

type Shown = 'live' | 'archived'

export function ProblemBank() {
  const navigate = useNavigate()
  const concepts = useConcepts()
  const [conceptId, setConceptId] = useState('')
  const [difficulty, setDifficulty] = useState('')
  const [q, setQ] = useState('')
  const [shown, setShown] = useState<Shown>('live')

  const filters: ProblemFilters = {
    statuses: shown === 'live' ? ['draft', 'published'] : ['archived'],
    conceptId: conceptId || undefined,
    difficulty: difficulty ? Number(difficulty) : undefined,
    q: q.trim() || undefined,
  }
  const problems = useProblems(filters)
  const labels = new Map((concepts.data ?? []).map((c) => [c.id, c.label]))

  return (
    <>
      <PageHeader title="Problems">
        <Button variant="secondary" onClick={() => navigate('/problems/import')}>
          Import
        </Button>
        <Button variant="primary" onClick={() => navigate('/problems/new')}>
          New problem
        </Button>
      </PageHeader>

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <TextInput label="Search titles" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select label="Concept" value={conceptId} onChange={(e) => setConceptId(e.target.value)}>
          <option value="">Any concept</option>
          {(concepts.data ?? []).map((concept) => (
            <option key={concept.id} value={concept.id}>
              {concept.label}
            </option>
          ))}
        </Select>
        <Select label="Difficulty" value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
          <option value="">Any</option>
          <option value="1">1 dot</option>
          <option value="2">2 dots</option>
          <option value="3">3 dots</option>
        </Select>
        <Select label="Showing" value={shown} onChange={(e) => setShown(e.target.value as Shown)}>
          <option value="live">Drafts and published</option>
          <option value="archived">Archived</option>
        </Select>
      </div>

      {shown === 'live' ? (
        <PublishDrafts drafts={(problems.data ?? []).filter((p) => p.status === 'draft')} />
      ) : null}

      {problems.isPending ? <Spinner label="Loading problems" /> : null}
      {problems.error ? <Notice tone="system-error">{messageFor(problems.error)}</Notice> : null}
      {problems.data && problems.data.length === 0 ? (
        <EmptyState title="No problems here yet">
          Write one with “New problem”. Every teacher at the centre shares this bank.
        </EmptyState>
      ) : null}

      <ul className="flex flex-col gap-2">
        {(problems.data ?? []).map((problem) => (
          <ProblemRow key={problem.id} problem={problem} labels={labels} />
        ))}
      </ul>
    </>
  )
}

function ProblemRow({
  problem,
  labels,
}: {
  problem: Schemas['ProblemSummaryOut']
  labels: Map<string, string>
}) {
  const main = problem.primary_concept_id ? labels.get(problem.primary_concept_id) : null
  const others = problem.concept_ids
    .filter((id) => id !== problem.primary_concept_id)
    .map((id) => labels.get(id))
    .filter(Boolean)
  return (
    <li>
      <Link
        to={`/problems/${problem.id}`}
        className="flex flex-wrap items-center gap-3 rounded-xl bg-paper px-5 py-3 ring-1 ring-ink/10 hover:ring-sky"
      >
        <Dots value={problem.difficulty} />
        <span className="font-medium text-ink">{problem.title}</span>
        {problem.part_labels.length ? (
          <span className="text-xs text-ink-soft">parts {problem.part_labels.join(', ')}</span>
        ) : null}
        <span className="flex flex-wrap gap-1">
          {main ? <Badge variant="active">★ {main}</Badge> : null}
          {others.map((label) => (
            <Badge key={label} variant="muted">
              {label}
            </Badge>
          ))}
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs text-ink-soft">
          {problem.test_count} check{problem.test_count === 1 ? '' : 's'}
          {problem.status === 'draft' ? <Badge variant="not-yet">Draft</Badge> : null}
          {problem.status === 'published' ? <Badge variant="good">Published</Badge> : null}
          {problem.version > 1 ? <span>v{problem.version}</span> : null}
        </span>
      </Link>
    </li>
  )
}
