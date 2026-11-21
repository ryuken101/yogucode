/**
 * One child's skills (Ken, 21 Nov 2026): their skill tree, game-style — every concept a
 * node, filled by how strong they are, ⟲ where it needs revisiting — or the same tree as
 * level bars. Click a node for the evidence: the lessons, homework and quizzes it came from.
 *
 * One child at a time, by Ken's choice; the class's view is the grid. Teacher-only: a
 * child's own view, if it comes, will have no numbers in it (spec §3.7).
 */

import { ChevronDown, ChevronRight, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { Badge } from '../components/Badge'
import { Card, EmptyState, PageHeader } from '../components/Card'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import type { Schemas } from '../lib/api'
import { messageFor } from '../lib/errors'
import { useSkillEvidence, useStudentSkills } from '../lib/queries'
import { FLAG_LABEL, LEVEL_FILL, LEVEL_LABEL, describe } from '../skills/levels'
import { Legend, LevelDot, RevisitMark } from '../skills/SkillMarks'
import '../skills/skillTree.css'

type SkillNode = Schemas['SkillNodeOut']
interface Branch {
  node: SkillNode
  depth: number
  children: Branch[]
}

function grow(nodes: SkillNode[]): Branch[] {
  const ids = new Set(nodes.map((n) => n.concept_id))
  const under = new Map<string | null, SkillNode[]>()
  for (const node of nodes) {
    const parent = node.parent_id && ids.has(node.parent_id) ? node.parent_id : null
    under.set(parent, [...(under.get(parent) ?? []), node])
  }
  const seen = new Set<string>()
  const build = (parent: string | null, depth: number): Branch[] =>
    [...(under.get(parent) ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label))
      .flatMap((node) => {
        if (seen.has(node.concept_id)) return []
        seen.add(node.concept_id)
        return [{ node, depth, children: build(node.concept_id, depth + 1) }]
      })
  return build(null, 0)
}

/** Only what the child has met: a branch that is "not taught" all the way down goes. */
function prune(branches: Branch[]): Branch[] {
  return branches.filter((b) => b.node.level !== 'not_taught').map((b) => ({ ...b, children: prune(b.children) }))
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')
}

const MODE: Record<string, string> = {
  classwork: 'Lesson',
  homework: 'Homework',
  quiz: 'Quiz',
}

/**
 * A node's evidence, under the tree (Ken, 21 Nov 2026: beside it, it squeezed the tree).
 * It scrolls itself into view when a node is chosen, and closes back to the tree alone.
 */
function Evidence({
  classId,
  studentId,
  node,
  onClose,
}: {
  classId: string
  studentId: string
  node: SkillNode
  onClose: () => void
}) {
  const evidence = useSkillEvidence(classId, studentId, node.concept_id)
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ref.current?.scrollIntoView?.({
      block: 'nearest',
      behavior: still ? 'auto' : 'smooth',
    })
  }, [node.concept_id])
  return (
    <Card className="!p-5">
      <section ref={ref} aria-label={`Where ${node.label} comes from`}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-display text-lg font-semibold text-grape">{node.label}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-muted hover:bg-cream"
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-sm text-grape">
          <LevelDot skill={node} size={16} />
          {describe(node)}
        </p>
        {node.revisit.length ? (
          <ul className="mt-2 space-y-0.5 text-sm text-grape">
            {node.revisit.map((flag) => (
              <li key={flag} className="flex items-center gap-1.5">
                <RevisitMark flags={[flag]} /> {FLAG_LABEL[flag]}
              </li>
            ))}
          </ul>
        ) : null}
        <h3 className="mt-4 text-sm font-medium text-grape">Where this comes from</h3>
        {evidence.isPending ? (
          <Spinner />
        ) : evidence.isError ? (
          <Notice tone="system-error">{messageFor(evidence.error)}</Notice>
        ) : !evidence.data.length ? (
          <p className="mt-1 text-sm text-muted">Nothing yet: no lesson, homework or quiz on this has been tried.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {evidence.data.map((e) => (
              <li key={e.attempt_id} className="py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={e.outcome >= 1 ? 'good' : 'not-yet'}>
                    {e.outcome >= 1 ? 'Got it' : e.outcome > 0 ? 'Part way' : 'Not yet'}
                  </Badge>
                  <span className="text-grape">{e.item_title}</span>
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  {MODE[e.mode] ?? e.mode} · {e.assignment_title} ·{' '}
                  {new Date(e.at).toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'short',
                  })}
                  {e.marked ? ' · marked' : ''}
                  {e.hints ? ` · ${e.hints} hint${e.hints === 1 ? '' : 's'}` : ''}
                  {e.helped ? ' · you helped' : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Card>
  )
}

export function SkillsChild() {
  const { classId = '', studentId = '' } = useParams()
  const [search, setSearch] = useSearchParams()
  const skills = useStudentSkills(classId, studentId)
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [view, setView] = useState<'tree' | 'bars'>('tree')
  const [everything, setEverything] = useState(false)
  const chosen = search.get('concept')

  if (skills.isPending) return <Spinner />
  if (skills.isError)
    return (
      <div className="p-6">
        <Notice tone="system-error">{messageFor(skills.error)}</Notice>
      </div>
    )

  const forest = grow(skills.data.nodes)
  // The child's tree shows what they have done (Ken, 21 Nov 2026): a concept they haven't
  // met yet is left off, unless asked for. A parent is kept whenever anything under it is.
  const shown = everything ? forest : prune(forest)
  const selected = skills.data.nodes.find((n) => n.concept_id === chosen) ?? null
  const choose = (id: string) =>
    setSearch(
      (was) => {
        const next = new URLSearchParams(was)
        next.set('concept', id)
        return next
      },
      { replace: true },
    )
  const unchoose = () =>
    setSearch(
      (was) => {
        const next = new URLSearchParams(was)
        next.delete('concept')
        return next
      },
      { replace: true },
    )
  const toggle = (id: string) =>
    setClosed((was) => {
      const next = new Set(was)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  function node(branch: Branch) {
    const { node: n } = branch
    const open = !closed.has(n.concept_id)
    const on = n.concept_id === chosen
    return (
      <li key={n.concept_id}>
        <button
          type="button"
          onClick={() => choose(n.concept_id)}
          aria-pressed={on}
          aria-label={`${n.label}: ${describe(n)}`}
          className={`relative flex w-24 flex-col items-center gap-1 rounded-2xl px-1 py-1.5 ${
            on ? 'bg-grape-pale ring-2 ring-grape' : 'hover:bg-cream'
          }`}
        >
          <LevelDot skill={n} size={branch.depth === 0 ? 40 : 30} />
          {n.revisit.length || (!open && n.below) ? (
            <span className="absolute top-1 right-3 rounded-full bg-surface">
              <RevisitMark flags={n.revisit} below={!open && n.below} />
            </span>
          ) : null}
          <span className={`text-center text-xs leading-tight text-grape ${branch.depth === 0 ? 'font-medium' : ''}`}>
            {n.label}
          </span>
        </button>
        {branch.children.length ? (
          <button
            type="button"
            onClick={() => toggle(n.concept_id)}
            aria-label={`${open ? 'Hide' : 'Show'} the sub-skills of ${n.label}`}
            className="mt-0.5 text-muted"
          >
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        ) : null}
        {branch.children.length && open ? <ul>{branch.children.map(node)}</ul> : null}
      </li>
    )
  }

  function bars(branches: Branch[]): React.ReactNode {
    return branches.flatMap((branch) => {
      const n = branch.node
      return [
        <li key={n.concept_id}>
          <button
            type="button"
            onClick={() => choose(n.concept_id)}
            aria-label={`${n.label}: ${describe(n)}`}
            className={`grid w-full grid-cols-[minmax(8rem,14rem)_1fr_7rem] items-center gap-3 rounded-xl py-1 pr-2 text-left ${
              n.concept_id === chosen ? 'bg-grape-pale' : 'hover:bg-cream'
            }`}
            style={{ paddingLeft: `${branch.depth * 1.25 + 0.5}rem` }}
          >
            <span className={`truncate text-sm text-grape ${branch.depth === 0 ? 'font-medium' : ''}`}>{n.label}</span>
            <span className="h-2.5 overflow-hidden rounded-full bg-cream ring-1 ring-line">
              <span
                className={`block h-full rounded-full ${n.level === 'secure' || n.level === 'learning' ? 'bg-good' : 'bg-not-yet'}`}
                style={{
                  width: `${LEVEL_FILL[n.level] * 100}%`,
                  opacity: n.confident ? 1 : 0.5,
                }}
              />
            </span>
            <span className="flex items-center gap-1 text-xs text-muted">
              {LEVEL_LABEL[n.level]}
              <RevisitMark flags={n.revisit} />
            </span>
          </button>
        </li>,
        ...(bars(branch.children) as React.ReactNode[]),
      ]
    })
  }

  return (
    <div className="p-6">
      <PageHeader title={skills.data.display_name}>
        <div role="group" aria-label="Show as" className="inline-flex rounded-2xl bg-cream p-1 ring-1 ring-line">
          {(['tree', 'bars'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`rounded-xl px-3 py-1 text-sm ${view === v ? 'bg-surface text-grape ring-1 ring-line' : 'text-muted'}`}
            >
              {v === 'tree' ? 'Tree' : 'Bars'}
            </button>
          ))}
        </div>
      </PageHeader>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <Legend />
        <label className="flex items-center gap-2 text-sm text-grape">
          <input
            type="checkbox"
            className="size-4 accent-grape"
            checked={everything}
            onChange={(event) => setEverything(event.target.checked)}
          />
          Show concepts not taught yet
        </label>
        <Link to={`/classes/${classId}/skills`} className="text-sm text-grape underline-offset-2 hover:underline">
          Back to the class
        </Link>
      </div>

      {!forest.length ? (
        <EmptyState title="No concepts yet">
          Add them in the <Link to="/skills/tree">skill tree</Link>.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {view === 'tree' ? (
            <Card className="!p-4 overflow-auto">
              <div className="skill-tree mx-auto w-max min-w-full">
                <ul>
                  <li>
                    <div
                      className="flex flex-col items-center gap-1 px-2 py-1"
                      aria-label={`${skills.data.display_name}’s skill tree`}
                    >
                      <span
                        aria-hidden
                        className="flex size-14 items-center justify-center rounded-full bg-grape font-display text-lg font-semibold text-surface"
                      >
                        {initials(skills.data.display_name)}
                      </span>
                      <span className="text-sm font-medium text-grape">{skills.data.display_name}</span>
                    </div>
                    {shown.length ? <ul>{shown.map(node)}</ul> : null}
                  </li>
                </ul>
              </div>
              {!shown.length ? (
                <p className="mt-3 text-center text-sm text-muted">
                  Nothing tried yet. Turn on “Show concepts not taught yet” to see the whole tree.
                </p>
              ) : null}
            </Card>
          ) : (
            <Card className="!p-3">
              <ul>{bars(shown)}</ul>
            </Card>
          )}
          {selected ? (
            <Evidence classId={classId} studentId={studentId} node={selected} onClose={unchoose} />
          ) : (
            <p className="text-center text-sm text-muted">Click a concept to see where its level comes from.</p>
          )}
        </div>
      )}
    </div>
  )
}
