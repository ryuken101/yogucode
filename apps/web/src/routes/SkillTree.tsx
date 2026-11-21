/**
 * The centre's skill tree, to shape (Ken, 21 Nov 2026; the Skills app's Tree tab).
 *
 * Every concept tag is a node, and any tag can have sub-skills, as deep as the teacher
 * likes: Dictionaries › .values() › in a loop. Any teacher or the owner can add, rename,
 * move, reorder and delete, built-ins included, and the tree is shared by the whole centre.
 * Deleting a tag takes its sub-skills with it, to the Trash, and the confirmation says how
 * many problems and lessons lose the tag. Problems are tagged at any depth in the editor;
 * a child's level on each node is the Skills app's other pages.
 */

import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Button } from '../components/Button'
import { Card, EmptyState, PageHeader } from '../components/Card'
import { Dialog } from '../components/Dialog'
import { Select } from '../components/Field'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { TrashDialog } from '../components/TrashDialog'
import { Menu } from '../desktop/Menu'
import { api, type Schemas } from '../lib/api'
import {
  branchIds,
  buildTree,
  flatten,
  impactNote,
  pathLabel,
  type Concept,
  type ConceptNode,
} from '../lib/conceptTree'
import { ApiError, messageFor } from '../lib/errors'
import { useConceptEdits, useConcepts } from '../lib/queries'

const INPUT = 'w-56 rounded-xl bg-surface px-2.5 py-1 text-sm text-grape ring-1 ring-grape outline-none'

type Adding = { parentId: string | null; label: string }

export function SkillTree() {
  const concepts = useConcepts()
  const edits = useConceptEdits()
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState<Adding | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null)
  const [moving, setMoving] = useState<Concept | null>(null)
  const [moveTo, setMoveTo] = useState('')
  const [removing, setRemoving] = useState<Concept | null>(null)
  const [impact, setImpact] = useState<Schemas['ConceptImpactOut'] | null>(null)
  const [error, setError] = useState<unknown>(null)

  const all = concepts.data ?? []
  const tree = buildTree(all)

  async function run(action: () => Promise<unknown>) {
    try {
      setError(null)
      await action()
      return true
    } catch (caught) {
      setError(caught)
      return false
    }
  }

  async function add() {
    if (!adding) return
    const label = adding.label.trim()
    if (!label) return setAdding(null)
    const parentId = adding.parentId
    if (await run(() => edits.create.mutateAsync({ label, parentId }))) {
      setAdding(null)
      if (parentId) setClosed((was) => new Set([...was].filter((id) => id !== parentId)))
    }
  }

  async function rename() {
    if (!renaming) return
    const label = renaming.label.trim()
    const was = all.find((c) => c.id === renaming.id)?.label
    if (!label || label === was) return setRenaming(null)
    if (await run(() => edits.update.mutateAsync({ id: renaming.id, label }))) setRenaming(null)
  }

  /** Swap with the sibling above or below. Siblings are renumbered when two share a place. */
  async function shift(node: ConceptNode, siblings: ConceptNode[], by: -1 | 1) {
    const at = siblings.indexOf(node)
    const other = siblings[at + by]
    if (!other) return
    const order = siblings.map((s) => s.concept)
    ;[order[at], order[at + by]] = [order[at + by], order[at]]
    const distinct = new Set(siblings.map((s) => s.concept.sort_order)).size === siblings.length
    await run(async () => {
      if (distinct) {
        await edits.update.mutateAsync({ id: node.concept.id, sort_order: other.concept.sort_order })
        await edits.update.mutateAsync({ id: other.concept.id, sort_order: node.concept.sort_order })
      } else {
        for (const [i, concept] of order.entries()) {
          const wanted = (i + 1) * 10
          if (concept.sort_order !== wanted) await edits.update.mutateAsync({ id: concept.id, sort_order: wanted })
        }
      }
    })
  }

  async function move() {
    if (!moving) return
    const parentId = moveTo === '' ? null : moveTo
    if (await run(() => edits.update.mutateAsync({ id: moving.id, parent_id: parentId }))) setMoving(null)
  }

  function askToRemove(concept: Concept) {
    setError(null)
    setImpact(null)
    setRemoving(concept)
    api.conceptImpact(concept.id).then(setImpact, () => setImpact(null))
  }

  function keys(event: KeyboardEvent<HTMLInputElement>, done: () => void, cancel: () => void) {
    if (event.key === 'Enter') {
      event.preventDefault()
      done()
    } else if (event.key === 'Escape') {
      event.stopPropagation()
      setError(null)
      cancel()
    }
  }

  function newField(parentId: string | null) {
    return (
      <input
        aria-label={parentId ? 'New sub-skill name' : 'New tag name'}
        placeholder={parentId ? 'New sub-skill' : 'New tag'}
        autoFocus
        maxLength={40}
        value={adding?.label ?? ''}
        disabled={edits.create.isPending}
        onChange={(event) => setAdding({ parentId, label: event.target.value })}
        onKeyDown={(event) => keys(event, () => void add(), () => setAdding(null))}
        onBlur={() => {
          if (!adding?.label.trim()) setAdding(null)
        }}
        className={INPUT}
      />
    )
  }

  function rows(nodes: ConceptNode[]): React.ReactNode {
    return (
      <ul role="group" className="space-y-0.5">
        {nodes.map((node, index) => {
          const { concept } = node
          const open = !closed.has(concept.id)
          const hasChildren = node.children.length > 0
          return (
            <li key={concept.id} role="treeitem" aria-expanded={hasChildren ? open : undefined} aria-label={concept.label}>
              <div
                className="group flex items-center gap-1.5 rounded-xl py-1 pr-2 hover:bg-cream"
                style={{ paddingLeft: `${node.depth * 1.5 + 0.25}rem` }}
              >
                {hasChildren ? (
                  <button
                    type="button"
                    aria-label={`${open ? 'Hide' : 'Show'} the sub-skills of ${concept.label}`}
                    onClick={() =>
                      setClosed((was) => {
                        const next = new Set(was)
                        if (open) next.add(concept.id)
                        else next.delete(concept.id)
                        return next
                      })
                    }
                    className="text-muted"
                  >
                    {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                  </button>
                ) : (
                  <span className="inline-block size-4" aria-hidden />
                )}
                {renaming?.id === concept.id ? (
                  <input
                    aria-label={`New name for ${concept.label}`}
                    autoFocus
                    maxLength={40}
                    value={renaming.label}
                    onChange={(event) => setRenaming({ id: concept.id, label: event.target.value })}
                    onKeyDown={(event) => keys(event, () => void rename(), () => setRenaming(null))}
                    onBlur={() => void rename()}
                    className={INPUT}
                  />
                ) : (
                  <span
                    className={`text-sm text-grape ${node.depth === 0 ? 'font-medium' : ''}`}
                    onDoubleClick={() => setRenaming({ id: concept.id, label: concept.label })}
                  >
                    {concept.label}
                  </span>
                )}
                {hasChildren ? <span className="text-xs text-muted">{flatten(node.children).length}</span> : null}
                <span className="ml-auto opacity-70 group-hover:opacity-100">
                  <Menu
                    label={`${concept.label} options`}
                    bare
                    align="right"
                    width="w-48"
                    items={[
                      { label: 'Add a sub-skill', onSelect: () => setAdding({ parentId: concept.id, label: '' }) },
                      { label: 'Rename', onSelect: () => setRenaming({ id: concept.id, label: concept.label }) },
                      {
                        label: 'Move to…',
                        onSelect: () => {
                          setError(null)
                          setMoveTo(concept.parent_id ?? '')
                          setMoving(concept)
                        },
                      },
                      ...(index > 0 ? [{ label: 'Move up', onSelect: () => void shift(node, nodes, -1) }] : []),
                      ...(index < nodes.length - 1
                        ? [{ label: 'Move down', onSelect: () => void shift(node, nodes, 1) }]
                        : []),
                      { label: 'Delete', onSelect: () => askToRemove(concept) },
                    ]}
                  >
                    <span aria-hidden className="px-1 text-muted">
                      ⋯
                    </span>
                  </Menu>
                </span>
              </div>
              {adding?.parentId === concept.id ? (
                <div className="py-1" style={{ paddingLeft: `${(node.depth + 1) * 1.5 + 1.5}rem` }}>
                  {newField(concept.id)}
                </div>
              ) : null}
              {hasChildren && open ? rows(node.children) : null}
            </li>
          )
        })}
      </ul>
    )
  }

  const refused = error instanceof ApiError && (error.status === 409 || error.status === 422)
  const blocked = moving ? branchIds(all, moving.id) : new Set<string>()

  return (
    <div className="mx-auto max-w-3xl p-6">
      <PageHeader title="Skill tree">
        <Button variant="primary" onClick={() => setAdding({ parentId: null, label: '' })}>
          New tag
        </Button>
      </PageHeader>
      <p className="mb-4 text-sm text-muted">
        The concepts your centre teaches, and the skills inside each. Tag problems at any level; every teacher at the
        centre shares this tree.
      </p>
      {error ? (
        <div className="mb-3">
          <Notice tone={refused ? 'not-yet' : 'system-error'}>{messageFor(error)}</Notice>
        </div>
      ) : null}
      {concepts.isPending ? (
        <Spinner />
      ) : concepts.isError ? (
        <Notice tone="system-error">{messageFor(concepts.error)}</Notice>
      ) : (
        <Card className="!p-4">
          {tree.length === 0 && adding?.parentId !== null ? (
            <EmptyState title="No tags yet">Add the first concept your centre teaches.</EmptyState>
          ) : (
            <div role="tree" aria-label="Skill tree">
              {rows(tree)}
            </div>
          )}
          {adding !== null && adding.parentId === null ? <div className="mt-2 pl-7">{newField(null)}</div> : null}
        </Card>
      )}

      <Dialog
        open={moving !== null}
        title={`Move “${moving?.label ?? ''}”`}
        onClose={() => setMoving(null)}
        confirm={{ label: 'Move', onConfirm: () => void move(), disabled: edits.update.isPending }}
      >
        <Select label="Put it under" value={moveTo} onChange={(event) => setMoveTo(event.target.value)}>
          <option value="">The top of the tree</option>
          {flatten(tree)
            .filter((node) => !blocked.has(node.concept.id))
            .map((node) => (
              <option key={node.concept.id} value={node.concept.id}>
                {pathLabel(all, node.concept.id)}
              </option>
            ))}
        </Select>
        <p className="mt-2 text-sm text-muted">Its sub-skills move with it.</p>
      </Dialog>

      <TrashDialog
        open={removing !== null}
        name={`the tag “${removing?.label ?? ''}”`}
        note={impactNote(impact)}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          const concept = removing
          setRemoving(null)
          if (concept) void run(() => edits.remove.mutateAsync(concept.id))
        }}
      />
    </div>
  )
}
