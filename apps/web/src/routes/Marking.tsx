/**
 * Marking homework: one question, one child at a time, across the class (spec §3.5).
 *
 * Opening a question re-runs every child's answer against the problem's checks — hidden
 * ones included — in this browser. That re-run, not the child's own report, fills in
 * **Runs** and **Correct** (all pass 2, some 1, none 0); **Approach** is the one human
 * call. ← and → (or J and K) move between children and save as they go, so marking a
 * question is a rhythm rather than a series of forms.
 *
 * The comment box draws on the centre's shared snippet bank — the misconceptions that
 * come up every week, worded once. **Release** gives everything marked back at once.
 *
 * A child who never pressed Hand in still appears, with their saved work (Ken's decision);
 * marking it takes a copy so the mark always points at the code it judged.
 */

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card, PageHeader } from '../components/Card'
import { Dialog } from '../components/Dialog'
import { TextInput, Textarea } from '../components/Field'
import { Markdown } from '../components/Markdown'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { api, type Schemas } from '../lib/api'
import { formatDue } from '../lib/dates'
import { messageFor } from '../lib/errors'
import { keys, useMarkingOverview, useMarkingQuestion, useSnippets } from '../lib/queries'
import { toChecks } from '../problems/doc'
import { correctFrom, runsFrom } from '../problems/rubric'
import { TestResultLine } from '../problems/TestResults'
import type { TestRun } from '../runtime/protocol'
import { usePython } from '../runtime/usePython'

type Entry = Schemas['MarkingEntryOut']

interface Form {
  runs: boolean
  correct: number
  approach: number | null
  comment: string
  snippetIds: string[]
}

function formFor(
  entry: Entry,
  run: TestRun | null | undefined,
  rightChoice: number | null = null,
): Form {
  if (entry.mark) {
    return {
      runs: entry.mark.runs,
      correct: entry.mark.correct,
      approach: entry.mark.approach,
      comment: entry.mark.comment_md,
      snippetIds: [],
    }
  }
  if (rightChoice !== null) {
    // Multiple choice: right or not, from the option picked. No "runs", no approach.
    return {
      runs: true,
      correct: entry.choice === rightChoice ? 2 : 0,
      approach: null,
      comment: '',
      snippetIds: [],
    }
  }
  return { runs: runsFrom(run), correct: correctFrom(run), approach: null, comment: '', snippetIds: [] }
}

function Scale({
  label,
  value,
  onChange,
}: {
  label: string
  value: number | null
  onChange: (value: number) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 text-sm font-medium text-grape">{label}</span>
      <div role="radiogroup" aria-label={label} className="inline-flex gap-1">
        {[0, 1, 2].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            onClick={() => onChange(n)}
            className={`w-9 rounded-lg py-1 text-sm ring-1 ${
              value === n ? 'bg-grape-pale ring-grape' : 'bg-surface ring-grape/20 hover:bg-cream'
            }`}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `/assignments/:id/mark` — straight to the first question. */
export function MarkingStart() {
  const { assignmentId = '' } = useParams()
  const overview = useMarkingOverview(assignmentId)
  if (overview.isPending) return <Spinner label="Loading" />
  if (overview.error) return <Notice tone="system-error">{messageFor(overview.error)}</Notice>
  const first = overview.data.questions[0]
  if (!first) return <Notice tone="info">This homework has no problems.</Notice>
  return <Navigate to={`/assignments/${assignmentId}/mark/${first.leaf_item_id}`} replace />
}

export function Marking() {
  const { assignmentId = '', itemId = '' } = useParams()
  const navigate = useNavigate()
  const client = useQueryClient()
  const overview = useMarkingOverview(assignmentId)
  const question = useMarkingQuestion(assignmentId, itemId)
  const snippets = useSnippets()
  const python = usePython()

  const [index, setIndex] = useState(0)
  const [runs, setRuns] = useState<Record<string, TestRun | null>>({})
  const [rerunning, setRerunning] = useState(0)
  const [forms, setForms] = useState<Record<string, Form>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [snippetQuery, setSnippetQuery] = useState('')
  const [confirmRelease, setConfirmRelease] = useState(false)
  const [released, setReleased] = useState<Schemas['ReleaseOut'] | null>(null)
  const [error, setError] = useState<unknown>(null)

  // A new question starts from the first child, with nothing unsaved carried over.
  useEffect(() => {
    setIndex(0)
    setForms({})
    setRuns({})
  }, [itemId])

  // Re-run every answer in this browser — the result marking trusts.
  const data = question.data
  useEffect(() => {
    if (!data) return
    let cancelled = false
    void (async () => {
      const checks = toChecks(data.tests, { revealHidden: true })
      // Multiple choice has nothing to run.
      const withCode = data.kind === 'mcq' ? [] : data.entries.filter((e) => e.code !== null)
      setRerunning(withCode.length)
      for (const entry of withCode) {
        const run = await python.check(entry.code ?? '', checks)
        if (cancelled) return
        setRuns((current) => ({ ...current, [entry.student_id]: run }))
        setRerunning((n) => n - 1)
      }
    })()
    return () => {
      cancelled = true
    }
    // `python.check` is stable for a page's life; re-run only when the question changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const entries = useMemo(() => data?.entries ?? [], [data])
  const entry = entries[index]

  async function saveCurrent() {
    if (!entry || !entry.attempt_id) return
    const form = forms[entry.student_id]
    if (!form) return
    const run = runs[entry.student_id]
    const saved = await api.saveMark(entry.attempt_id, {
      runs: form.runs,
      correct: form.correct,
      approach: form.approach,
      comment_md: form.comment,
      verified_passed: run ? run.results.filter((r) => r.passed).length : null,
      verified_total: run ? run.results.length : null,
      snippet_ids: form.snippetIds,
    })
    client.setQueryData(
      keys.markingQuestion(assignmentId, itemId),
      (current: Schemas['QuestionMarkingOut'] | undefined) =>
        current && {
          ...current,
          entries: current.entries.map((e) => (e.student_id === entry.student_id ? { ...e, mark: saved } : e)),
        },
    )
    setForms((current) => {
      const rest = { ...current }
      delete rest[entry.student_id]
      return rest
    })
    await client.invalidateQueries({ queryKey: keys.marking(assignmentId), exact: true })
    if (form.snippetIds.length) await client.invalidateQueries({ queryKey: keys.snippets })
  }

  async function go(next: number) {
    if (next < 0 || next >= entries.length) return
    try {
      setError(null)
      await saveCurrent()
      setIndex(next)
    } catch (caught) {
      setError(caught)
    }
  }

  // ← → and J K, unless the teacher is typing a comment.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (event.key === 'ArrowRight' || event.key === 'k') void go(index + 1)
      if (event.key === 'ArrowLeft' || event.key === 'j') void go(index - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (question.isPending || overview.isPending) return <Spinner label="Loading answers" />
  if (question.error || overview.error) {
    return <Notice tone="system-error">{messageFor(question.error ?? overview.error)}</Notice>
  }
  if (!data || !entry) return <Notice tone="info">Nobody in this class yet.</Notice>

  const run = runs[entry.student_id]
  const isMcq = data.kind === 'mcq'
  const rightChoice = isMcq ? data.options.findIndex((o) => o.correct) : null
  const form = forms[entry.student_id] ?? formFor(entry, run, rightChoice)
  const setForm = (patch: Partial<Form>) =>
    setForms((current) => ({ ...current, [entry.student_id]: { ...form, ...patch } }))
  const note = notes[entry.student_id] ?? entry.note
  const conceptIds = new Set(data.concept_ids)
  const shownSnippets = (snippets.data ?? [])
    .filter((s) => !snippetQuery || s.body.toLowerCase().includes(snippetQuery.toLowerCase()))
    .sort((a, b) => Number(b.concept_id !== null && conceptIds.has(b.concept_id)) - Number(a.concept_id !== null && conceptIds.has(a.concept_id)))
    .slice(0, 6)

  return (
    <>
      <PageHeader title={overview.data.title}>
        <span className="text-sm text-muted">due {formatDue(overview.data.due_at)}</span>
        <Button variant="primary" onClick={() => setConfirmRelease(true)}>
          Give back marked work
        </Button>
      </PageHeader>

      {released ? (
        <div className="mb-4">
          <Notice tone="good">
            Given back: {released.marks_released} mark{released.marks_released === 1 ? '' : 's'}
            {released.notes_released ? ` and ${released.notes_released} note${released.notes_released === 1 ? '' : 's'}` : ''}.
          </Notice>
        </div>
      ) : null}

      {/* Questions */}
      <div role="tablist" aria-label="Questions" className="mb-4 flex flex-wrap gap-1.5">
        {overview.data.questions.map((q) => (
          <button
            key={q.leaf_item_id}
            role="tab"
            aria-selected={q.leaf_item_id === itemId}
            onClick={() => {
              void saveCurrent().then(() => navigate(`/assignments/${assignmentId}/mark/${q.leaf_item_id}`))
            }}
            className={`rounded-lg px-3 py-1.5 text-sm ring-1 ${
              q.leaf_item_id === itemId ? 'bg-grape-pale ring-grape' : 'bg-surface ring-grape/20'
            }`}
          >
            {q.title} <span className="text-muted">· {q.marked} marked</span>
          </button>
        ))}
      </div>

      {/* Children */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {entries.map((e, i) => (
          <button
            key={e.student_id}
            onClick={() => void go(i)}
            aria-current={i === index}
            className={`rounded-full px-2.5 py-1 text-xs ring-1 ${
              i === index ? 'bg-grape-pale ring-grape' : 'bg-surface ring-grape/20'
            }`}
          >
            {e.mark ? '● ' : e.code === null ? '– ' : '○ '}
            {e.display_name}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1 text-sm text-muted">
          <Button variant="quiet" aria-label="Previous child" disabled={index === 0} onClick={() => void go(index - 1)}>
            ←
          </Button>
          {index + 1} of {entries.length}
          <Button
            variant="quiet"
            aria-label="Next child"
            disabled={index === entries.length - 1}
            onClick={() => void go(index + 1)}
          >
            →
          </Button>
        </span>
      </div>

      {rerunning > 0 ? (
        <p className="mb-3 text-sm text-muted">Re-running checks… {rerunning} to go</p>
      ) : null}
      {error ? (
        <div className="mb-3">
          <Notice tone="system-error">{messageFor(error)}</Notice>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <Card>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="font-display font-semibold text-lg text-grape">{entry.display_name}</h2>
            {entry.source === 'hand_in' ? (
              <span className="text-sm text-muted">handed in {formatDue(entry.submitted_at)}</span>
            ) : null}
            {entry.source === 'not_handed_in' ? <Badge variant="muted">Not handed in — saved work</Badge> : null}
            {entry.source === 'saved_work' ? <Badge variant="muted">Marked from saved work</Badge> : null}
            {entry.late ? <Badge variant="not-yet">Late</Badge> : null}
            <span className="ml-auto text-sm text-muted">Hints used: {entry.hints_used}</span>
          </div>
          {entry.mark?.stale ? (
            <div className="mb-3">
              <Notice tone="info">Handed in again since you marked this — the code below is the new version.</Notice>
            </div>
          ) : null}
          {isMcq ? (
            entry.choice === null || entry.choice === undefined ? (
              <p className="text-muted">No answer chosen.</p>
            ) : (
              <div className="flex flex-col gap-1">
                <p className="font-mono text-base text-grape">{data.options[entry.choice]?.text}</p>
                <p className="text-sm text-muted">
                  {entry.choice === rightChoice
                    ? 'The right answer.'
                    : data.options[entry.choice]?.misconception
                      ? `Suggests: ${data.options[entry.choice]?.misconception}`
                      : 'Not the right answer.'}
                </p>
              </div>
            )
          ) : entry.code === null ? (
            <p className="text-muted">Not started — nothing to mark.</p>
          ) : (
            <pre className="max-h-96 overflow-auto rounded-lg bg-night p-3 font-mono text-sm text-cream">
              {entry.code || '(nothing written)'}
            </pre>
          )}
        </Card>

        {isMcq ? (
          <Card>
            <h2 className="mb-2 font-display font-semibold text-lg text-grape">The class’s answers</h2>
            <ul className="flex flex-col gap-1.5 text-sm">
              {data.options.map((option, i) => (
                <li key={i} className="flex items-baseline gap-2">
                  <span className="w-6 text-right font-medium text-grape">{option.chosen_by}</span>
                  <span className="font-mono text-grape">{option.text}</span>
                  {option.correct ? <Badge variant="good">right</Badge> : null}
                  {!option.correct && option.misconception ? (
                    <span className="text-muted">— {option.misconception}</span>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="mt-3">
              <Button
                variant="secondary"
                onClick={() =>
                  void api
                    .autoMark(assignmentId, itemId)
                    .then(() =>
                      Promise.all([
                        client.invalidateQueries({ queryKey: keys.markingQuestion(assignmentId, itemId) }),
                        client.invalidateQueries({ queryKey: keys.marking(assignmentId), exact: true }),
                      ]),
                    )
                    .catch(setError)
                }
              >
                Mark all automatically
              </Button>
            </div>
          </Card>
        ) : (
        <Card>
          <h2 className="mb-2 font-display font-semibold text-lg text-grape">Checks (re-run)</h2>
          {entry.code === null ? null : run === undefined ? (
            <Spinner label="Running" />
          ) : run === null ? (
            <Notice tone="not-yet">The checks could not finish.</Notice>
          ) : run.compile_error ? (
            <Notice tone="not-yet">Python could not read it: {run.compile_error}</Notice>
          ) : (
            <div className="flex flex-col gap-1.5">
              {run.results.map((result, i) => (
                <TestResultLine key={i} result={{ ...result, hidden: data.tests[i]?.hidden ?? false }} />
              ))}
            </div>
          )}
          {entry.child_total !== null ? (
            <p className="mt-2 text-xs text-muted">
              Their own check at hand-in: {entry.child_passed} of {entry.child_total}
            </p>
          ) : null}
        </Card>
        )}
      </div>

      {entry.attempt_id ? (
        <Card className="mt-4">
          <div className="flex flex-wrap items-center gap-6">
            {isMcq ? null : (
            <div className="flex items-center gap-2">
              <span className="w-20 text-sm font-medium text-grape">Runs</span>
              <button
                type="button"
                aria-pressed={form.runs}
                onClick={() => setForm({ runs: !form.runs })}
                className={`w-12 rounded-lg py-1 text-sm ring-1 ${form.runs ? 'bg-grape-pale ring-grape' : 'bg-surface ring-grape/20'}`}
              >
                {form.runs ? '✓' : '—'}
              </button>
            </div>
            )}
            <Scale label="Correct" value={form.correct} onChange={(correct) => setForm({ correct })} />
            {isMcq ? null : (
              <Scale label="Approach" value={form.approach} onChange={(approach) => setForm({ approach })} />
            )}
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[3fr_2fr]">
            <div className="flex flex-col gap-2">
              <Textarea
                label="Comment for the student"
                rows={3}
                value={form.comment}
                onChange={(event) => setForm({ comment: event.target.value })}
              />
              <div className="flex gap-2">
                <Button
                  variant="quiet"
                  disabled={!form.comment.trim()}
                  onClick={() =>
                    void api
                      .createSnippet({ body: form.comment.trim(), concept_id: data.concept_ids[0] ?? null })
                      .then(() => client.invalidateQueries({ queryKey: keys.snippets }))
                  }
                >
                  Save as a snippet
                </Button>
              </div>
              {form.comment ? (
                <div className="rounded-lg bg-cream/60 px-3 py-1 text-sm ring-1 ring-line">
                  <Markdown>{form.comment}</Markdown>
                </div>
              ) : null}
            </div>
            <div className="flex flex-col gap-2">
              <TextInput
                label="Snippets"
                placeholder="Search…"
                value={snippetQuery}
                onChange={(event) => setSnippetQuery(event.target.value)}
              />
              <ul className="flex flex-col gap-1">
                {shownSnippets.map((snippet) => (
                  <li key={snippet.id}>
                    <button
                      type="button"
                      onClick={() =>
                        setForm({
                          comment: form.comment ? `${form.comment.trimEnd()}\n${snippet.body}` : snippet.body,
                          snippetIds: [...form.snippetIds, snippet.id],
                        })
                      }
                      className="w-full rounded-lg bg-surface px-3 py-1.5 text-left text-sm text-grape ring-1 ring-line hover:ring-grape"
                    >
                      {snippet.body}
                    </button>
                  </li>
                ))}
                {shownSnippets.length === 0 ? (
                  <li className="text-sm text-muted">No snippets yet — save a comment you’ll reuse.</li>
                ) : null}
              </ul>
            </div>
          </div>

          <div className="mt-4">
            <Textarea
              label={`Overall note to ${entry.display_name} on this homework (optional)`}
              rows={2}
              value={note}
              onChange={(event) => setNotes((current) => ({ ...current, [entry.student_id]: event.target.value }))}
              onBlur={() => {
                if (note !== entry.note) {
                  void api.saveNote(assignmentId, entry.student_id, note).catch(setError)
                }
              }}
            />
          </div>

          <div className="mt-4 flex gap-2">
            <Button variant="primary" onClick={() => void go(index + 1).then(() => undefined)} disabled={index === entries.length - 1}>
              Save and next →
            </Button>
            <Button variant="secondary" onClick={() => void saveCurrent().catch(setError)}>
              Save
            </Button>
          </div>
        </Card>
      ) : null}

      <Dialog
        open={confirmRelease}
        title="Give back marked work?"
        onClose={() => setConfirmRelease(false)}
        confirm={{
          label: 'Give it back',
          onConfirm: () => {
            setConfirmRelease(false)
            void saveCurrent()
              .then(() => api.releaseHomework(assignmentId))
              .then((result) => {
                setReleased(result)
                return client.invalidateQueries({ queryKey: keys.marking(assignmentId) })
              })
              .catch(setError)
          },
        }}
      >
        Every child you have marked sees your comments, and their homework becomes read-only.
        Anyone not marked yet is unaffected — you can give theirs back later.
      </Dialog>
    </>
  )
}
