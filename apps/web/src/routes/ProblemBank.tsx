/**
 * The problem bank: every problem at the centre, sorted into categories (Ken, 7 Nov 2026).
 * The bank sorts itself by concept; folders are the teachers' own groups on top of that,
 * and a problem can be in several (`problems/useBankBrowser.ts`, `routers/problem_folders.py`).
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
import { Dialog } from '../components/Dialog'
import { Dots } from '../components/Dots'
import { Select, TextInput } from '../components/Field'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { TrashDialog } from '../components/TrashDialog'
import { Menu } from '../desktop/Menu'
import type { Schemas } from '../lib/api'
import { messageFor } from '../lib/errors'
import { useProblemFolderEdit, useTrashAction } from '../lib/queries'
import { BankSidebar, PROBLEM_DRAG_TYPE } from '../problems/BankSidebar'
import { PublishDrafts } from '../problems/PublishDrafts'
import { useBankBrowser } from '../problems/useBankBrowser'

type NamedFolder = { id: string; name: string }

const LIVE_STATUSES: Schemas['ItemStatus'][] = ['draft', 'published']

export function ProblemBank() {
  const navigate = useNavigate()
  const bank = useBankBrowser({ statuses: LIVE_STATUSES, withArchived: true, rememberCategory: true })
  const edit = useProblemFolderEdit()
  const trash = useTrashAction()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [naming, setNaming] = useState<{ folder: NamedFolder | null; thenAdd: string[] } | null>(null)
  const [deleting, setDeleting] = useState<NamedFolder | null>(null)
  const [said, setSaid] = useState<string | null>(null)

  const folderId = bank.category.startsWith('folder:') ? bank.category.slice('folder:'.length) : null
  const archived = bank.category === 'archived'
  const visible = bank.shown.filter((p) => selected.has(p.id))

  function choose(category: string) {
    bank.choose(category)
    setSelected(new Set())
    setSaid(null)
  }

  async function addTo(id: string, name: string, itemIds: string[]) {
    await edit.add.mutateAsync({ folderId: id, itemIds })
    setSelected(new Set())
    setSaid(`Added ${itemIds.length} to ${name}.`)
  }

  async function removeSelected() {
    if (!folderId) return
    const count = visible.length
    for (const problem of visible) await edit.remove.mutateAsync({ folderId, itemId: problem.id })
    setSelected(new Set())
    setSaid(`Took ${count} out of ${bank.title}.`)
  }

  const failure = edit.add.error ?? edit.remove.error
  const filtering = bank.q.trim() !== '' || bank.difficulty !== ''

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

      <div className="mb-5 grid gap-3 sm:grid-cols-[3fr_1fr]">
        <TextInput label="Search titles" value={bank.q} onChange={(e) => bank.setQ(e.target.value)} />
        <Select label="Difficulty" value={bank.difficulty} onChange={(e) => bank.setDifficulty(e.target.value)}>
          <option value="">Any</option>
          <option value="1">1 dot</option>
          <option value="2">2 dots</option>
          <option value="3">3 dots</option>
        </Select>
      </div>

      <div className="grid gap-5 md:grid-cols-[14rem_minmax(0,1fr)]">
        {/* Stays in view with its own scroll: a long list mustn't carry the folders away. */}
        <div className="md:sticky md:top-2 md:max-h-[calc(100dvh-13rem)] md:self-start md:overflow-y-auto">
          <BankSidebar
            groups={bank.groups}
            category={bank.category}
            onChoose={choose}
            editing={{
              onNew: () => setNaming({ folder: null, thenAdd: [] }),
              onRename: (folder) => setNaming({ folder, thenAdd: [] }),
              onDelete: setDeleting,
              onDropProblems: (id, itemIds) => {
                const folder = bank.groups.folders.find((f) => f.id === id)
                if (folder) void addTo(id, folder.name, itemIds).catch(() => undefined)
              },
            }}
          />
        </div>

        <section aria-label={bank.title} className="min-w-0">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="min-w-0 font-display font-semibold text-lg text-grape [overflow-wrap:anywhere]">{bank.title}</h2>
            <span className="text-sm text-muted">
              {bank.shown.length} problem{bank.shown.length === 1 ? '' : 's'}
            </span>
          </div>

          {said ? (
            <div className="mb-3" aria-live="polite">
              <Notice tone="info">{said}</Notice>
            </div>
          ) : null}
          {failure ? (
            <div className="mb-3">
              <Notice tone="system-error">{messageFor(failure)}</Notice>
            </div>
          ) : null}

          {!archived ? <PublishDrafts drafts={bank.shown.filter((p) => p.status === 'draft')} /> : null}

          {visible.length > 0 ? (
            <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-2xl bg-grape-pale px-4 py-2 ring-1 ring-grape/25">
              <span className="text-sm font-medium text-grape">{visible.length} selected</span>
              <Menu
                label="Add to folder"
                items={[
                  ...bank.groups.folders.map((f) => ({
                    label: f.name,
                    onSelect: () => void addTo(f.id, f.name, visible.map((p) => p.id)).catch(() => undefined),
                  })),
                  {
                    label: 'New folder…',
                    onSelect: () => setNaming({ folder: null, thenAdd: visible.map((p) => p.id) }),
                  },
                ]}
              >
                Add to folder
              </Menu>
              {folderId ? (
                <Button variant="quiet" onClick={() => void removeSelected().catch(() => undefined)}>
                  Remove from this folder
                </Button>
              ) : null}
              <Button variant="quiet" className="ml-auto" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          ) : null}

          {bank.isPending ? <Spinner label="Loading problems" /> : null}
          {bank.error ? <Notice tone="system-error">{messageFor(bank.error)}</Notice> : null}
          {!bank.isPending && !bank.error && bank.shown.length === 0 ? (
            filtering ? (
              <EmptyState title="No problems match">
                {bank.category !== 'all' ? (
                  <button type="button" className="font-medium text-grape-deep" onClick={() => choose('all')}>
                    Look in all problems
                  </button>
                ) : (
                  'Try a different search.'
                )}
              </EmptyState>
            ) : folderId ? (
              <EmptyState title="Nothing in this folder yet">
                Tick problems and choose “Add to folder”, or drag them onto this folder.
              </EmptyState>
            ) : (
              <EmptyState title="No problems here yet">
                Write one with “New problem”. Every teacher at the centre shares this bank.
              </EmptyState>
            )
          ) : null}

          <ul className="flex flex-col gap-2">
            {bank.shown.map((problem) => (
              <ProblemRow
                key={problem.id}
                problem={problem}
                labels={bank.labels}
                selectable={!archived}
                selected={selected.has(problem.id)}
                onToggle={() =>
                  setSelected((now) => {
                    const next = new Set(now)
                    if (next.has(problem.id)) next.delete(problem.id)
                    else next.add(problem.id)
                    return next
                  })
                }
                dragged={selected.has(problem.id) ? visible.map((p) => p.id) : [problem.id]}
              />
            ))}
          </ul>
        </section>
      </div>

      {naming ? (
        <FolderNameDialog
          folder={naming.folder}
          onClose={() => setNaming(null)}
          onSaved={(folder) => {
            const add = naming.thenAdd
            setNaming(null)
            if (add.length) void addTo(folder.id, folder.name, add).catch(() => undefined)
          }}
        />
      ) : null}

      <TrashDialog
        open={deleting !== null}
        name={deleting ? `“${deleting.name}”` : ''}
        note="Only the folder goes. The problems in it stay in the bank."
        busy={trash.isPending}
        error={trash.error ? messageFor(trash.error) : null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return
          trash.mutate(
            { action: 'trash', kind: 'problem_folder', id: deleting.id },
            { onSuccess: () => setDeleting(null) },
          )
        }}
      />
    </>
  )
}

function FolderNameDialog({
  folder,
  onClose,
  onSaved,
}: {
  folder: NamedFolder | null
  onClose: () => void
  onSaved: (folder: NamedFolder) => void
}) {
  const edit = useProblemFolderEdit()
  const [name, setName] = useState(folder?.name ?? '')
  const busy = edit.create.isPending || edit.rename.isPending
  const failure = edit.create.error ?? edit.rename.error
  const save = () => {
    const done = { onSuccess: (saved: NamedFolder) => onSaved(saved) }
    if (folder) edit.rename.mutate({ folderId: folder.id, name: name.trim() }, done)
    else edit.create.mutate(name.trim(), done)
  }
  return (
    <Dialog
      open
      title={folder ? 'Rename folder' : 'New folder'}
      onClose={onClose}
      confirm={{ label: folder ? 'Rename' : 'Make folder', disabled: !name.trim() || busy, onConfirm: save }}
    >
      <TextInput
        label="Folder name"
        autoFocus
        maxLength={60}
        placeholder="Term 4 quizzes"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim() && !busy) save()
        }}
      />
      <p className="mt-2 text-muted">Every teacher at the centre can see and use it.</p>
      {failure ? (
        <div className="mt-3">
          <Notice tone="not-yet">{messageFor(failure)}</Notice>
        </div>
      ) : null}
    </Dialog>
  )
}

function ProblemRow({
  problem,
  labels,
  selectable,
  selected,
  onToggle,
  dragged,
}: {
  problem: Schemas['ProblemSummaryOut']
  labels: Map<string, string>
  selectable: boolean
  selected: boolean
  onToggle: () => void
  /** What dragging this row carries: every ticked problem, if this is one of them. */
  dragged: string[]
}) {
  const main = problem.primary_concept_id ? labels.get(problem.primary_concept_id) : null
  const others = problem.concept_ids
    .filter((id) => id !== problem.primary_concept_id)
    .map((id) => labels.get(id))
    .filter(Boolean)
  return (
    <li
      draggable={selectable}
      onDragStart={(event) => {
        event.dataTransfer.setData(PROBLEM_DRAG_TYPE, JSON.stringify(dragged))
        event.dataTransfer.effectAllowed = 'copy'
      }}
      className={`flex items-center rounded-2xl bg-surface ring-1 ${selected ? 'ring-2 ring-grape' : 'ring-line hover:ring-grape'}`}
    >
      {selectable ? (
        <label className="flex shrink-0 cursor-pointer items-center self-stretch py-3 pl-4 pr-1">
          <input type="checkbox" aria-label={`Select ${problem.title}`} checked={selected} onChange={onToggle} />
        </label>
      ) : null}
      <Link
        to={`/problems/${problem.id}`}
        className="flex min-w-0 flex-1 flex-wrap items-center gap-3 px-3 py-3 sm:pr-5"
      >
        <Dots value={problem.difficulty} />
        <span className="min-w-0 font-medium text-grape [overflow-wrap:anywhere]">{problem.title}</span>
        {problem.kind === 'mcq' ? <Badge variant="muted">Multiple choice</Badge> : null}
        {problem.part_labels.length ? (
          <span className="text-xs text-muted">parts {problem.part_labels.join(', ')}</span>
        ) : null}
        <span className="flex flex-wrap gap-1">
          {main ? <Badge variant="active">★ {main}</Badge> : null}
          {others.map((label) => (
            <Badge key={label} variant="muted">
              {label}
            </Badge>
          ))}
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted">
          {problem.test_count} check{problem.test_count === 1 ? '' : 's'}
          {problem.status === 'draft' ? <Badge variant="not-yet">Draft</Badge> : null}
          {problem.status === 'published' ? <Badge variant="good">Published</Badge> : null}
          {problem.version > 1 ? <span>v{problem.version}</span> : null}
        </span>
      </Link>
    </li>
  )
}
