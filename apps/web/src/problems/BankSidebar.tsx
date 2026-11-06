/**
 * The bank's categories, with how many problems are in each: a column beside the list, and
 * a dropdown above it where there's no room for a column. The same on the Problems page and
 * in the picker, except that only the page edits folders and takes dragged problems.
 *
 * Folders come above concepts: there are 18 concepts, and a folder has to be in reach of the
 * row being dragged onto it.
 */

import { useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import { Select } from '../components/Field'
import { Menu } from '../desktop/Menu'
import type { BankGroups, Category } from './useBankBrowser'

/** What a problem row being dragged carries: the ids of the problems going. */
export const PROBLEM_DRAG_TYPE = 'application/x-yogucode-problems'

export interface FolderEditing {
  onNew: () => void
  onRename: (folder: { id: string; name: string }) => void
  onDelete: (folder: { id: string; name: string }) => void
  onDropProblems: (folderId: string, itemIds: string[]) => void
}

function Row({
  on,
  label,
  count,
  onChoose,
  after,
  ...rest
}: {
  on: boolean
  label: string
  count: number | null
  onChoose: () => void
  after?: ReactNode
  className?: string
  onDragOver?: (event: DragEvent) => void
  onDragLeave?: () => void
  onDrop?: (event: DragEvent) => void
}) {
  const { className = '', ...drop } = rest
  return (
    <li className={`flex items-center rounded-xl ${on ? 'bg-grape-pale' : 'hover:bg-cream'} ${className}`} {...drop}>
      <button
        type="button"
        aria-current={on ? 'true' : undefined}
        onClick={onChoose}
        className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-xl px-3 py-1.5 text-left text-sm text-grape focus-visible:outline-2 focus-visible:outline-grape-deep"
      >
        <span className={`min-w-0 break-words [overflow-wrap:anywhere] ${on ? 'font-semibold' : ''}`}>{label}</span>
        {count === null ? null : <span className="shrink-0 text-xs text-muted">{count}</span>}
      </button>
      {after}
    </li>
  )
}

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="mb-1 mt-4 px-3 text-xs font-semibold uppercase tracking-wide text-muted">{children}</h3>
}

export function BankSidebar({
  groups,
  category,
  onChoose,
  editing,
  label = 'Categories',
}: {
  groups: BankGroups
  category: Category
  onChoose: (category: Category) => void
  editing?: FolderEditing
  label?: string
}) {
  const [dropOn, setDropOn] = useState<string | null>(null)

  const dropProps = (folderId: string) =>
    editing
      ? {
          onDragOver: (event: DragEvent) => {
            if (!event.dataTransfer.types.includes(PROBLEM_DRAG_TYPE)) return
            event.preventDefault()
            setDropOn(folderId)
          },
          onDragLeave: () => setDropOn((now) => (now === folderId ? null : now)),
          onDrop: (event: DragEvent) => {
            event.preventDefault()
            setDropOn(null)
            const raw = event.dataTransfer.getData(PROBLEM_DRAG_TYPE)
            if (raw) editing.onDropProblems(folderId, JSON.parse(raw) as string[])
          },
        }
      : {}

  return (
    <>
      {/* Narrow: the same choices as a dropdown, so the list keeps the width. */}
      <div className="md:hidden">
        <Select label={label} value={category} onChange={(event) => onChoose(event.target.value)}>
          <option value="all">All problems ({groups.all})</option>
          {groups.untagged > 0 ? <option value="untagged">Needs a concept ({groups.untagged})</option> : null}
          {groups.archived !== null ? <option value="archived">Archived ({groups.archived})</option> : null}
          {groups.folders.length ? (
            <optgroup label="Folders">
              {groups.folders.map((f) => (
                <option key={f.id} value={`folder:${f.id}`}>
                  {f.name} ({f.count})
                </option>
              ))}
            </optgroup>
          ) : null}
          {groups.concepts.length ? (
            <optgroup label="Concepts">
              {groups.concepts.map((c) => (
                <option key={c.id} value={`concept:${c.id}`}>
                  {c.label} ({c.count})
                </option>
              ))}
            </optgroup>
          ) : null}
        </Select>
        {editing ? (
          <button type="button" onClick={editing.onNew} className="mt-2 text-sm font-medium text-grape-deep">
            + New folder
          </button>
        ) : null}
      </div>

      <nav aria-label={label} className="hidden md:block">
        <ul>
          <Row on={category === 'all'} label="All problems" count={groups.all} onChoose={() => onChoose('all')} />
          {groups.untagged > 0 ? (
            <Row
              on={category === 'untagged'}
              label="Needs a concept"
              count={groups.untagged}
              onChoose={() => onChoose('untagged')}
            />
          ) : null}
          {groups.archived !== null ? (
            <Row
              on={category === 'archived'}
              label="Archived"
              count={groups.archived}
              onChoose={() => onChoose('archived')}
            />
          ) : null}
        </ul>

        {groups.folders.length || editing ? (
          <>
            <Heading>Folders</Heading>
            <ul>
              {groups.folders.map((f) => (
                <Row
                  key={f.id}
                  on={category === `folder:${f.id}`}
                  label={f.name}
                  count={f.count}
                  onChoose={() => onChoose(`folder:${f.id}`)}
                  className={dropOn === f.id ? 'ring-2 ring-grape' : ''}
                  {...dropProps(f.id)}
                  after={
                    editing ? (
                      <Menu
                        label={`${f.name} options`}
                        bare
                        align="right"
                        width="w-40"
                        items={[
                          { label: 'Rename', onSelect: () => editing.onRename(f) },
                          { label: 'Delete', onSelect: () => editing.onDelete(f) },
                        ]}
                      >
                        <span aria-hidden className="px-1 text-muted">
                          ⋯
                        </span>
                      </Menu>
                    ) : null
                  }
                />
              ))}
            </ul>
            {editing ? (
              <button
                type="button"
                onClick={editing.onNew}
                className="mt-1 rounded-xl px-3 py-1.5 text-sm font-medium text-grape-deep hover:bg-cream"
              >
                + New folder
              </button>
            ) : null}
          </>
        ) : null}
        {groups.concepts.length ? (
          <>
            <Heading>Concepts</Heading>
            <ul>
              {groups.concepts.map((c) => (
                <Row
                  key={c.id}
                  on={category === `concept:${c.id}`}
                  label={c.label}
                  count={c.count}
                  onChoose={() => onChoose(`concept:${c.id}`)}
                />
              ))}
            </ul>
          </>
        ) : null}

      </nav>
    </>
  )
}
