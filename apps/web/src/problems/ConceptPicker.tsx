/**
 * Concept tags, with one marked as the main one.
 *
 * Spec §3.7: every question carries a concept tag, and Phase 8 mastery reads the *main*
 * tag to know what a problem mostly tests. Chips toggle membership; the star picks the
 * main one. Picking the first tag makes it main automatically — the common case is a
 * problem about one thing.
 *
 * The tags are the centre's tree (Ken, 21 Nov 2026): each top-level tag starts a row, with
 * its sub-skills after it, and a problem can be tagged at any depth. Every tag has a ⋯
 * menu — rename, add a sub-skill, delete (with its sub-skills, to the Trash) — built-ins
 * too: the first edit copies them into the centre, and the ids this screen holds are
 * mapped across by key. "+ New tag" adds one at the top and puts it on this problem.
 * A refusal is shown in words, never in the error colour.
 */

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Menu } from '../desktop/Menu'
import { Notice } from '../components/Notice'
import { TrashDialog } from '../components/TrashDialog'
import { api, type Schemas } from '../lib/api'
import { buildTree, flatten, impactNote, remapByKey, type Concept } from '../lib/conceptTree'
import { ApiError, messageFor } from '../lib/errors'
import { useConceptEdits } from '../lib/queries'

interface Props {
  concepts: Concept[]
  selected: string[]
  primary: string | null
  onChange: (selected: string[], primary: string | null) => void
  disabled?: boolean
}

/** A refusal (a name in use, a tag that can't go there) is "not yet"; anything else is ours. */
function Problem({ error }: { error: unknown }) {
  const refused = error instanceof ApiError && (error.status === 409 || error.status === 422)
  return (
    <div className="mt-1.5">
      <Notice tone={refused ? 'not-yet' : 'system-error'}>{messageFor(error)}</Notice>
    </div>
  )
}

const INPUT = 'w-36 rounded-full bg-surface px-2.5 py-1 text-xs text-grape ring-1 ring-grape outline-none'

type Adding = { parentId: string | null; label: string }

export function ConceptPicker({ concepts, selected, primary, onChange, disabled }: Props) {
  const edits = useConceptEdits()
  const [adding, setAdding] = useState<Adding | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null)
  const [removing, setRemoving] = useState<Concept | null>(null)
  const [impact, setImpact] = useState<Schemas['ConceptImpactOut'] | null>(null)
  const [error, setError] = useState<unknown>(null)

  // After the first edit the built-ins come back with the centre's ids: carry the
  // problem's tags across, or they would silently drop off the chips.
  const before = useRef(concepts)
  useEffect(() => {
    const previous = before.current
    before.current = concepts
    if (previous === concepts || !selected.length) return
    const next = remapByKey(selected, previous, concepts)
    if (next.some((id, i) => id !== selected[i])) {
      const main = primary ? remapByKey([primary], previous, concepts)[0] : null
      onChange(next, main)
    }
  }, [concepts, selected, primary, onChange])

  function toggle(id: string) {
    if (selected.includes(id)) {
      const rest = selected.filter((other) => other !== id)
      onChange(rest, primary === id ? (rest[0] ?? null) : primary)
    } else {
      onChange([...selected, id], primary ?? id)
    }
  }

  async function add() {
    if (!adding) return
    const label = adding.label.trim()
    if (!label) return setAdding(null)
    try {
      setError(null)
      const made = await edits.create.mutateAsync({ label, parentId: adding.parentId })
      setAdding(null)
      onChange([...selected, made.id], primary ?? made.id)
    } catch (caught) {
      setError(caught)
    }
  }

  async function rename() {
    if (!renaming) return
    const label = renaming.label.trim()
    const was = concepts.find((c) => c.id === renaming.id)?.label
    if (!label || label === was) return setRenaming(null)
    try {
      setError(null)
      await edits.update.mutateAsync({ id: renaming.id, label })
      setRenaming(null)
    } catch (caught) {
      setError(caught)
    }
  }

  function askToRemove(concept: Concept) {
    setError(null)
    setImpact(null)
    setRemoving(concept)
    api.conceptImpact(concept.id).then(setImpact, () => setImpact(null))
  }

  async function remove(concept: Concept) {
    setRemoving(null)
    try {
      setError(null)
      await edits.remove.mutateAsync(concept.id)
    } catch (caught) {
      setError(caught)
    }
  }

  function keys(event: KeyboardEvent<HTMLInputElement>, done: () => void, cancel: () => void) {
    if (event.key === 'Enter') {
      event.preventDefault()
      done()
    } else if (event.key === 'Escape') {
      // Stay in the editor: Escape here means "never mind", not "close the window".
      event.stopPropagation()
      setError(null)
      cancel()
    }
  }

  function newTagField(parentId: string | null) {
    return (
      <input
        aria-label={parentId ? 'New sub-skill name' : 'New tag name'}
        placeholder={parentId ? 'New sub-skill' : 'New tag name'}
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

  function chip(concept: Concept, depth: number) {
    const on = selected.includes(concept.id)
    const main = primary === concept.id
    if (renaming?.id === concept.id) {
      return (
        <input
          key={concept.id}
          aria-label={`New name for ${concept.label}`}
          autoFocus
          maxLength={40}
          value={renaming.label}
          onChange={(event) => setRenaming({ id: concept.id, label: event.target.value })}
          onKeyDown={(event) => keys(event, () => void rename(), () => setRenaming(null))}
          onBlur={() => void rename()}
          className={INPUT}
        />
      )
    }
    return (
      <span
        key={concept.id}
        className={`inline-flex items-center rounded-full text-xs ring-1 ${
          on ? 'bg-grape-pale ring-grape' : depth ? 'bg-cream ring-grape/15' : 'bg-surface ring-grape/20'
        }`}
      >
        {depth ? (
          <span aria-hidden className="pl-2 text-muted">
            {'›'.repeat(depth)}
          </span>
        ) : null}
        <button type="button" aria-pressed={on} onClick={() => toggle(concept.id)} className="px-2.5 py-1 text-grape">
          {concept.label}
        </button>
        {on ? (
          <button
            type="button"
            aria-label={`Make ${concept.label} the main concept`}
            aria-pressed={main}
            onClick={() => onChange(selected, concept.id)}
            className={`pr-2 ${main ? 'text-grape-deep' : 'text-muted/50 hover:text-muted'}`}
          >
            ★
          </button>
        ) : null}
        {!disabled ? (
          <Menu
            label={`${concept.label} options`}
            bare
            align="right"
            width="w-44"
            items={[
              { label: 'Rename', onSelect: () => setRenaming({ id: concept.id, label: concept.label }) },
              { label: 'Add a sub-skill', onSelect: () => setAdding({ parentId: concept.id, label: '' }) },
              { label: 'Delete', onSelect: () => askToRemove(concept) },
            ]}
          >
            <span aria-hidden className="pr-2 text-muted">
              ⋯
            </span>
          </Menu>
        ) : null}
      </span>
    )
  }

  const tree = buildTree(concepts)

  return (
    <fieldset disabled={disabled}>
      <legend className="mb-1.5 text-sm font-medium text-grape">Concepts</legend>
      <div className="space-y-1.5">
        {tree.map((root) => {
          const nodes = flatten([root])
          return (
            <div key={root.concept.id} className="flex flex-wrap items-center gap-1.5">
              {nodes.flatMap((node) => {
                const shown = [chip(node.concept, node.depth)]
                if (adding?.parentId === node.concept.id) {
                  shown.push(<span key={`${node.concept.id}-new`}>{newTagField(node.concept.id)}</span>)
                }
                return shown
              })}
            </div>
          )
        })}
        <div>
          {adding !== null && adding.parentId === null ? (
            newTagField(null)
          ) : (
            <button
              type="button"
              onClick={() => {
                setError(null)
                setAdding({ parentId: null, label: '' })
              }}
              className="rounded-full px-2.5 py-1 text-xs font-medium text-grape-deep ring-1 ring-grape/30 hover:bg-cream"
            >
              + New tag
            </button>
          )}
        </div>
      </div>
      {error ? <Problem error={error} /> : null}
      {selected.length > 0 ? <p className="mt-1.5 text-xs text-muted">★ marks the main concept.</p> : null}

      <TrashDialog
        open={removing !== null}
        name={`the tag “${removing?.label ?? ''}”`}
        note={impactNote(impact)}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && void remove(removing)}
      />
    </fieldset>
  )
}
