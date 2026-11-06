/**
 * Going through the problem bank by category (Ken, 7 Nov 2026): every concept the bank uses,
 * and the teachers' own folders. Shared by the Problems page and the builders' picker.
 *
 * The whole list comes once and is sorted here rather than asked for per category, so the
 * counts beside each category can follow what is typed in the search as it is typed. A bank
 * of a few hundred rows of titles and tags is small.
 *
 * A concept group holds every problem with that tag, on the problem or any of its parts, as
 * the old concept filter did. So one problem can appear under several, and the counts can
 * add up to more than the total.
 */

import { useMemo, useState } from 'react'
import type { Schemas } from '../lib/api'
import { useConcepts, useProblemFolders, useProblems } from '../lib/queries'

export type Problem = Schemas['ProblemSummaryOut']

/** `all`, `untagged`, `archived`, `concept:<id>` or `folder:<id>`. */
export type Category = string

export interface BankGroups {
  all: number
  untagged: number
  archived: number | null
  concepts: { id: string; label: string; count: number }[]
  folders: { id: string; name: string; count: number }[]
}

const REMEMBERED = 'yogucode-bank-category'

function remembered(): Category {
  try {
    return window.localStorage.getItem(REMEMBERED) ?? 'all'
  } catch {
    return 'all' // Private window or blocked storage: it just isn't remembered.
  }
}

function remember(category: Category) {
  try {
    window.localStorage.setItem(REMEMBERED, category)
  } catch {
    // As above.
  }
}

export function useBankBrowser({
  statuses,
  withArchived = false,
  rememberCategory = false,
}: {
  statuses: Schemas['ItemStatus'][]
  /** The Problems page offers Archived; the picker, for live problems only, does not. */
  withArchived?: boolean
  rememberCategory?: boolean
}) {
  const live = useProblems({ statuses })
  const archived = useProblems({ statuses: ['archived'] }, withArchived)
  const concepts = useConcepts()
  const folders = useProblemFolders()
  const [chosen, setChosen] = useState<Category>(() => (rememberCategory ? remembered() : 'all'))
  const [q, setQ] = useState('')
  const [difficulty, setDifficulty] = useState('')

  const groups = useMemo(() => {
    const words = q.trim().toLowerCase()
    const matches = (p: Problem) =>
      (!words || p.title.toLowerCase().includes(words)) && (!difficulty || p.difficulty === Number(difficulty))
    const every = live.data ?? []
    const rows = every.filter(matches)
    const inUse = new Set(every.flatMap((p) => p.concept_ids))
    const out: BankGroups = {
      all: rows.length,
      untagged: rows.filter((p) => p.concept_ids.length === 0).length,
      archived: withArchived ? (archived.data ?? []).filter(matches).length : null,
      // In curriculum order, as the API returns them; only those the bank uses.
      concepts: (concepts.data ?? [])
        .filter((c) => inUse.has(c.id))
        .map((c) => ({ id: c.id, label: c.label, count: rows.filter((p) => p.concept_ids.includes(c.id)).length })),
      folders: (folders.data ?? []).map((f) => ({
        id: f.id,
        name: f.name,
        count: rows.filter((p) => p.folder_ids.includes(f.id)).length,
      })),
    }
    return { out, rows, matches }
  }, [live.data, archived.data, concepts.data, folders.data, q, difficulty, withArchived])

  // A remembered folder may have been deleted since, or a concept no longer used.
  const known =
    chosen === 'all' ||
    chosen === 'untagged' ||
    (chosen === 'archived' && withArchived) ||
    (chosen.startsWith('concept:') && groups.out.concepts.some((c) => `concept:${c.id}` === chosen)) ||
    (chosen.startsWith('folder:') && groups.out.folders.some((f) => `folder:${f.id}` === chosen))
  const loaded = !live.isPending && !concepts.isPending && !folders.isPending
  const category: Category = known || !loaded ? chosen : 'all'

  let shown: Problem[] = groups.rows
  let title = 'All problems'
  if (category === 'untagged') {
    shown = groups.rows.filter((p) => p.concept_ids.length === 0)
    title = 'Needs a concept'
  } else if (category === 'archived') {
    shown = (archived.data ?? []).filter(groups.matches)
    title = 'Archived'
  } else if (category.startsWith('concept:')) {
    const id = category.slice('concept:'.length)
    shown = groups.rows.filter((p) => p.concept_ids.includes(id))
    title = groups.out.concepts.find((c) => c.id === id)?.label ?? title
  } else if (category.startsWith('folder:')) {
    const id = category.slice('folder:'.length)
    shown = groups.rows.filter((p) => p.folder_ids.includes(id))
    title = groups.out.folders.find((f) => f.id === id)?.name ?? title
  }

  function choose(next: Category) {
    setChosen(next)
    if (rememberCategory) remember(next)
  }

  return {
    category,
    choose,
    title,
    shown,
    groups: groups.out,
    q,
    setQ,
    difficulty,
    setDifficulty,
    labels: new Map((concepts.data ?? []).map((c) => [c.id, c.label])),
    isPending: !loaded || (category === 'archived' && archived.isPending),
    error: live.error ?? concepts.error ?? folders.error ?? (category === 'archived' ? archived.error : null),
  }
}
