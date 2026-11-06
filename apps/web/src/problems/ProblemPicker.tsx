/**
 * Choosing problems for a quiz, a homework or a lesson (Ken, 7 Nov 2026): the bank's
 * categories and search, tick as many as there's room for, and add them in the order ticked.
 * Published problems only. Replaces a dropdown that got longer with every problem written.
 */

import { useState } from 'react'
import { Badge } from '../components/Badge'
import { Dialog } from '../components/Dialog'
import { Dots } from '../components/Dots'
import { Select, TextInput } from '../components/Field'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import type { Schemas } from '../lib/api'
import { messageFor } from '../lib/errors'
import { BankSidebar } from './BankSidebar'
import { useBankBrowser, type Problem } from './useBankBrowser'

const PUBLISHED: Schemas['ItemStatus'][] = ['published']

export function ProblemPicker({
  onList,
  limit,
  onClose,
  onAdd,
}: {
  /** What's already on the list: shown ticked, and can't be added twice. */
  onList: Set<string>
  limit: number
  onClose: () => void
  onAdd: (problems: Problem[]) => void
}) {
  const bank = useBankBrowser({ statuses: PUBLISHED })
  const [ticked, setTicked] = useState<Problem[]>([])
  const room = limit - onList.size
  const left = room - ticked.length

  function toggle(problem: Problem) {
    setTicked((now) =>
      now.some((p) => p.id === problem.id) ? now.filter((p) => p.id !== problem.id) : [...now, problem],
    )
  }

  return (
    <Dialog
      open
      wide
      title="Add problems"
      onClose={onClose}
      confirm={{
        label: ticked.length ? `Add ${ticked.length} problem${ticked.length === 1 ? '' : 's'}` : 'Add problems',
        disabled: ticked.length === 0,
        onConfirm: () => onAdd(ticked),
      }}
    >
      <div className="mb-3 grid gap-3 sm:grid-cols-[2fr_1fr]">
        <TextInput label="Search titles" value={bank.q} onChange={(e) => bank.setQ(e.target.value)} />
        <Select label="Difficulty" value={bank.difficulty} onChange={(e) => bank.setDifficulty(e.target.value)}>
          <option value="">Any</option>
          <option value="1">1 dot</option>
          <option value="2">2 dots</option>
          <option value="3">3 dots</option>
        </Select>
      </div>
      <div className="grid gap-3 md:grid-cols-[13rem_1fr]">
        <div className="md:max-h-96 md:overflow-y-auto">
          <BankSidebar groups={bank.groups} category={bank.category} onChoose={bank.choose} />
        </div>
        <div className="min-w-0">
          <p className="mb-2 font-medium text-grape" aria-live="polite">
            {bank.title} <span className="font-normal text-muted">· {bank.shown.length}</span>
          </p>
          {bank.isPending ? <Spinner label="Loading problems" /> : null}
          {bank.error ? <Notice tone="system-error">{messageFor(bank.error)}</Notice> : null}
          {!bank.isPending && !bank.error && bank.shown.length === 0 ? (
            <p className="text-muted">No published problems here{bank.q || bank.difficulty ? ' match' : ''}.</p>
          ) : null}
          <ul className="flex max-h-56 flex-col gap-1.5 overflow-y-auto p-0.5 md:max-h-96">
            {bank.shown.map((problem) => {
              const already = onList.has(problem.id)
              const on = ticked.some((p) => p.id === problem.id)
              return (
                <li key={problem.id}>
                  <label
                    className={`flex items-center gap-3 rounded-xl px-3 py-2 ring-1 ${
                      already ? 'opacity-60 ring-line' : on ? 'bg-grape-pale ring-grape' : 'ring-line hover:ring-grape'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={already || on}
                      disabled={already || (!on && left <= 0)}
                      onChange={() => toggle(problem)}
                    />
                    <Dots value={problem.difficulty} />
                    <span className="min-w-0 flex-1 font-medium text-grape [overflow-wrap:anywhere]">{problem.title}</span>
                    {problem.kind === 'mcq' ? <Badge variant="muted">Multiple choice</Badge> : null}
                    {already ? <span className="shrink-0 text-xs text-muted">on the list</span> : null}
                  </label>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
      <p className="mt-3 text-sm text-muted" aria-live="polite">
        {left > 0
          ? `Room for ${left} more (${limit} at most).`
          : `That’s the most this list can hold (${limit}).`}
      </p>
    </Dialog>
  )
}
