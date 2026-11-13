/**
 * Concept tags, with one marked as the main one.
 *
 * Spec §3.7: every question carries a concept tag, and Phase 8 mastery reads the *main*
 * tag to know what a problem mostly tests. Chips toggle membership; the star picks the
 * main one. Picking the first tag makes it main automatically — the common case is a
 * problem about one thing.
 *
 * Teachers add the centre's own tags here too (Ken, 14 Nov 2026): "+ New tag" creates one
 * and puts it on this problem. The centre's own tags have a ⋯ menu to rename or remove; the
 * built-in ones are edited only as YAML and have none. Removing a tag something still uses
 * is refused by the server, and the refusal is shown in words, never in the error colour.
 */

import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Menu } from '../desktop/Menu'
import { Dialog } from '../components/Dialog'
import { Notice } from '../components/Notice'
import type { Schemas } from '../lib/api'
import { ApiError, messageFor } from '../lib/errors'
import { useConceptEdits } from '../lib/queries'

interface Props {
  concepts: Schemas['ConceptOut'][]
  selected: string[]
  primary: string | null
  onChange: (selected: string[], primary: string | null) => void
  disabled?: boolean
}

/** A refusal (a name in use, a tag still on a problem) is "not yet"; anything else is ours. */
function Problem({ error }: { error: unknown }) {
  const refused = error instanceof ApiError && (error.status === 409 || error.status === 422)
  return (
    <div className="mt-1.5">
      <Notice tone={refused ? 'not-yet' : 'system-error'}>{messageFor(error)}</Notice>
    </div>
  )
}

const INPUT = 'w-36 rounded-full bg-surface px-2.5 py-1 text-xs text-grape ring-1 ring-grape outline-none'

export function ConceptPicker({ concepts, selected, primary, onChange, disabled }: Props) {
  const edits = useConceptEdits()
  const [adding, setAdding] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null)
  const [removing, setRemoving] = useState<Schemas['ConceptOut'] | null>(null)
  const [error, setError] = useState<unknown>(null)

  function toggle(id: string) {
    if (selected.includes(id)) {
      const rest = selected.filter((other) => other !== id)
      onChange(rest, primary === id ? (rest[0] ?? null) : primary)
    } else {
      onChange([...selected, id], primary ?? id)
    }
  }

  async function add() {
    const label = adding?.trim()
    if (!label) return setAdding(null)
    try {
      setError(null)
      const made = await edits.create.mutateAsync(label)
      setAdding(null)
      onChange([...selected, made.id], primary ?? made.id)
    } catch (caught) {
      setError(caught)
    }
  }

  async function rename() {
    if (!renaming) return
    const label = renaming.label.trim()
    const before = concepts.find((c) => c.id === renaming.id)?.label
    if (!label || label === before) return setRenaming(null)
    try {
      setError(null)
      await edits.rename.mutateAsync({ id: renaming.id, label })
      setRenaming(null)
    } catch (caught) {
      setError(caught)
    }
  }

  async function remove(concept: Schemas['ConceptOut']) {
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

  return (
    <fieldset disabled={disabled}>
      <legend className="mb-1.5 text-sm font-medium text-grape">Concepts</legend>
      <div className="flex flex-wrap gap-1.5">
        {concepts.map((concept) => {
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
                on ? 'bg-grape-pale ring-grape' : 'bg-surface ring-grape/20'
              }`}
            >
              <button
                type="button"
                aria-pressed={on}
                onClick={() => toggle(concept.id)}
                className="px-2.5 py-1 text-grape"
              >
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
              {concept.own && !disabled ? (
                <Menu
                  label={`${concept.label} options`}
                  bare
                  align="right"
                  width="w-40"
                  items={[
                    { label: 'Rename', onSelect: () => setRenaming({ id: concept.id, label: concept.label }) },
                    { label: 'Remove', onSelect: () => setRemoving(concept) },
                  ]}
                >
                  <span aria-hidden className="pr-2 text-muted">
                    ⋯
                  </span>
                </Menu>
              ) : null}
            </span>
          )
        })}
        {adding === null ? (
          <button
            type="button"
            onClick={() => {
              setError(null)
              setAdding('')
            }}
            className="rounded-full px-2.5 py-1 text-xs font-medium text-grape-deep ring-1 ring-grape/30 hover:bg-cream"
          >
            + New tag
          </button>
        ) : (
          <input
            aria-label="New tag name"
            placeholder="New tag name"
            autoFocus
            maxLength={40}
            value={adding}
            disabled={edits.create.isPending}
            onChange={(event) => setAdding(event.target.value)}
            onKeyDown={(event) => keys(event, () => void add(), () => setAdding(null))}
            onBlur={() => {
              if (!adding.trim()) setAdding(null)
            }}
            className={INPUT}
          />
        )}
      </div>
      {error ? <Problem error={error} /> : null}
      {selected.length > 0 ? (
        <p className="mt-1.5 text-xs text-muted">★ marks the main concept.</p>
      ) : null}

      <Dialog
        open={removing !== null}
        title={`Remove the tag “${removing?.label ?? ''}”?`}
        onClose={() => setRemoving(null)}
        confirm={{ label: 'Remove tag', onConfirm: () => removing && void remove(removing) }}
      >
        <p className="text-sm">
          It disappears from the tag list for every teacher at the centre. A tag that a problem or lesson still uses
          can’t be removed. Take it off them first.
        </p>
      </Dialog>
    </fieldset>
  )
}
