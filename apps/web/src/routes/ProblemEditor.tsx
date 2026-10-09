/**
 * Write, check and publish one problem.
 *
 * The page holds the whole problem document in state and saves it whole (see
 * `app/problem_bank.py`). Three rules shape it:
 *
 * - **Only a draft is editable.** A published problem shows read-only with "Make
 *   changes", which opens (or creates) the draft of its next version. Marks stay attached
 *   to the version a child actually saw.
 * - **Publishing needs the reference solution to pass, in this browser, against what is
 *   saved.** "Check solution" saves first, runs every leaf's solution against its tests
 *   in Pyodide, and remembers the `updated_at` it ran against. Any edit after that makes
 *   the run stale and Publish goes back to disabled. The server checks the same
 *   timestamp, so a second tab cannot slip a stale run through either.
 * - **Nothing a teacher's solution fails is shown as an error.** It is "not yet", like a
 *   child's.
 */

import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card, PageHeader } from '../components/Card'
import { Dialog } from '../components/Dialog'
import { DotsPicker } from '../components/Dots'
import { TextInput, Textarea } from '../components/Field'
import { Markdown } from '../components/Markdown'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { api, type Schemas } from '../lib/api'
import { messageFor } from '../lib/errors'
import { useConcepts, useProblem, useProblemMutation } from '../lib/queries'
import {
  emptyLeaf,
  emptyPart,
  emptyProblem,
  leavesOf,
  nextPartLabel,
  type LeafDoc,
  type ProblemDoc,
} from '../problems/doc'
import { ConceptPicker } from '../problems/ConceptPicker'
import { LeafEditor } from '../problems/LeafEditor'
import { McqEditor } from '../problems/McqEditor'
import { runPassed, verifyProblem, type Verification } from '../problems/verify'
import { usePython } from '../runtime/usePython'

const STATUS_BADGE: Record<Schemas['ItemStatus'], { label: string; variant: 'active' | 'good' | 'muted' }> = {
  draft: { label: 'Draft', variant: 'active' },
  published: { label: 'Published', variant: 'good' },
  superseded: { label: 'Older version', variant: 'muted' },
  archived: { label: 'Archived', variant: 'muted' },
}

export function ProblemEditor() {
  const { itemId } = useParams<{ itemId: string }>()
  const navigate = useNavigate()
  const problem = useProblem(itemId ?? null)
  const concepts = useConcepts()
  const python = usePython()

  const [doc, setDoc] = useState<ProblemDoc | null>(itemId ? null : emptyProblem())
  const [savedJson, setSavedJson] = useState<string | null>(null)
  const [verification, setVerification] = useState<Verification | null>(null)
  const [checking, setChecking] = useState(false)
  const [preview, setPreview] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)

  const create = useProblemMutation((body: ProblemDoc) => api.createProblem(body))
  const save = useProblemMutation((body: ProblemDoc) => api.saveProblem(itemId ?? '', body))
  const publish = useProblemMutation((updatedAt: string) =>
    api.publishProblem(itemId ?? '', updatedAt),
  )
  const newVersion = useProblemMutation(() => api.newProblemVersion(itemId ?? ''))
  const archive = useProblemMutation(() => api.archiveProblem(itemId ?? ''))
  const unarchive = useProblemMutation(() => api.unarchiveProblem(itemId ?? ''))

  // Take the server's copy whenever a *different version* of it arrives — on load, after
  // a save, after a publish. Keyed on id and updated_at so a background refetch of the
  // same version cannot overwrite what the teacher is typing.
  const loaded = problem.data
  useEffect(() => {
    if (!loaded) return
    setDoc(loaded.document)
    setSavedJson(JSON.stringify(loaded.document))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded?.id, loaded?.updated_at])

  const editable = !itemId || loaded?.status === 'draft'
  const dirty = doc !== null && JSON.stringify(doc) !== savedJson
  const leaves = useMemo(() => (doc ? leavesOf(doc) : []), [doc])
  const verified =
    verification !== null && !dirty && loaded !== undefined && verification.updatedAt === loaded.updated_at
  const allPass = verified && leaves.every((leaf) => runPassed(verification.runs[leaf.key]))
  const gaps = loaded && !dirty ? loaded.publish_problems : []
  const warnings = loaded && !dirty ? loaded.publish_warnings : []
  // A multiple-choice question has nothing to run: publishing needs only a clean save.
  const isMcq = doc?.kind === 'mcq'

  if (itemId && problem.isPending) return <Spinner label="Loading problem" />
  if (problem.error) return <Notice tone="system-error">{messageFor(problem.error)}</Notice>
  if (!doc) return null

  const mutationError =
    create.error ?? save.error ?? publish.error ?? newVersion.error ?? archive.error ?? unarchive.error

  async function persist(): Promise<Schemas['ProblemOut'] | null> {
    if (!doc) return null
    if (!itemId) {
      const created = await create.mutateAsync(doc)
      navigate(`/problems/${created.id}`, { replace: true })
      return created
    }
    if (!dirty && loaded) return loaded
    return save.mutateAsync(doc)
  }

  async function checkSolution() {
    setChecking(true)
    try {
      const saved = await persist()
      if (!saved) return
      setVerification(await verifyProblem(python.check, saved))
    } catch {
      // The mutation's own error state carries the message.
    } finally {
      setChecking(false)
    }
  }

  function setLeaf(key: string, leaf: LeafDoc) {
    setDoc((current) => {
      if (!current) return current
      if (key === '') return { ...current, ...leaf }
      return {
        ...current,
        parts: (current.parts ?? []).map((part) =>
          part.label === key ? { ...part, ...leaf } : part,
        ),
      }
    })
  }

  /**
   * Splitting a problem moves what it already has into part (a), rather than starting
   * the parts empty and leaving the problem's own tests stranded on the parent — which
   * publishing would then refuse.
   */
  function splitIntoParts() {
    setDoc((current) => {
      if (!current) return current
      const { difficulty, concept_ids, primary_concept_id, starter_code, solution_code, tests, hints } =
        current
      return {
        ...current,
        ...emptyLeaf(),
        difficulty,
        parts: [
          {
            ...emptyPart('a'),
            difficulty,
            concept_ids,
            primary_concept_id,
            starter_code,
            solution_code,
            tests,
            hints,
          },
        ],
      }
    })
  }

  const busy = create.isPending || save.isPending || checking
  const status = loaded?.status ?? 'draft'
  const pythonUnavailable = python.state.status === 'unsupported'

  return (
    <>
      <PageHeader title={doc.title || 'New problem'}>
        <Badge variant={STATUS_BADGE[status].variant}>{STATUS_BADGE[status].label}</Badge>
        {loaded ? <span className="text-sm text-muted">v{loaded.version}</span> : null}
      </PageHeader>

      {mutationError ? (
        <div className="mb-4">
          <Notice tone="not-yet">{messageFor(mutationError)}</Notice>
        </div>
      ) : null}

      {!editable ? (
        <Card className="mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">
              {status === 'published'
                ? 'Published problems are not edited in place, so marks stay tied to the version students saw.'
                : status === 'archived'
                  ? 'This problem is archived.'
                  : 'A newer version of this problem has replaced this one.'}
            </p>
            <div className="flex gap-2">
              {status === 'published' ? (
                <>
                  <Button
                    variant="primary"
                    disabled={newVersion.isPending}
                    onClick={() =>
                      newVersion.mutate(undefined, {
                        onSuccess: (draft) => navigate(`/problems/${draft.id}`),
                      })
                    }
                  >
                    Make changes
                  </Button>
                  <Button variant="quiet" onClick={() => setConfirmArchive(true)}>
                    Archive
                  </Button>
                </>
              ) : null}
              {status === 'archived' ? (
                <Button variant="secondary" onClick={() => unarchive.mutate(undefined)}>
                  Bring back as a draft
                </Button>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}

      <Card className="mb-6">
        <div className="flex flex-col gap-4">
          {!itemId ? (
            <div role="radiogroup" aria-label="Kind of question" className="flex gap-2">
              {(['code', 'mcq'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={doc.kind === kind}
                  onClick={() =>
                    setDoc({
                      ...doc,
                      kind,
                      parts: kind === 'mcq' ? [] : doc.parts,
                      options:
                        kind === 'mcq' && (doc.options ?? []).length === 0
                          ? [
                              { text: '', correct: true, misconception: null },
                              { text: '', correct: false, misconception: null },
                            ]
                          : doc.options,
                    })
                  }
                  className={`rounded-lg px-3 py-1.5 text-sm ring-1 ${
                    doc.kind === kind ? 'bg-grape-pale ring-grape' : 'bg-surface ring-grape/20'
                  }`}
                >
                  {kind === 'code' ? 'Code problem' : 'Multiple choice'}
                </button>
              ))}
            </div>
          ) : null}
          <TextInput
            label="Title"
            value={doc.title}
            maxLength={120}
            disabled={!editable}
            onChange={(event) => setDoc({ ...doc, title: event.target.value })}
          />
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-sm font-medium text-grape">Prompt</span>
              <Button variant="quiet" onClick={() => setPreview(!preview)}>
                {preview ? 'Edit' : 'Preview'}
              </Button>
            </div>
            {preview || !editable ? (
              <div className="rounded-lg bg-cream/60 px-4 py-2 ring-1 ring-line">
                <Markdown>{doc.prompt_md || '*No prompt yet.*'}</Markdown>
              </div>
            ) : (
              <Textarea
                label="What the student reads (markdown: `code`, **bold**, lists)"
                rows={6}
                value={doc.prompt_md}
                onChange={(event) => setDoc({ ...doc, prompt_md: event.target.value })}
              />
            )}
          </div>
          {(doc.parts ?? []).length > 0 ? (
            <div>
              <p className="mb-1.5 text-sm font-medium text-grape">Overall difficulty</p>
              <DotsPicker
                value={doc.difficulty}
                disabled={!editable}
                onChange={(difficulty) => setDoc({ ...doc, difficulty })}
              />
            </div>
          ) : null}
        </div>
      </Card>

      {concepts.data && isMcq ? (
        <Card className="mb-6">
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-start gap-6">
              <div>
                <p className="mb-1.5 text-sm font-medium text-grape">Difficulty</p>
                <DotsPicker
                  value={doc.difficulty}
                  disabled={!editable}
                  onChange={(difficulty) => setDoc({ ...doc, difficulty })}
                />
              </div>
              <div className="min-w-0 flex-1">
                <ConceptPicker
                  concepts={concepts.data}
                  selected={doc.concept_ids ?? []}
                  primary={doc.primary_concept_id ?? null}
                  disabled={!editable}
                  onChange={(concept_ids, primary_concept_id) =>
                    setDoc({ ...doc, concept_ids, primary_concept_id })
                  }
                />
              </div>
            </div>
            <McqEditor
              options={doc.options ?? []}
              disabled={!editable}
              onChange={(options) => setDoc({ ...doc, options })}
            />
          </div>
        </Card>
      ) : concepts.data ? (
        leaves.map((leaf) => (
          <Card key={leaf.key || 'whole'} className="mb-6">
            {leaf.key ? (
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-display font-semibold text-xl text-grape">{leaf.title}</h2>
                {editable ? (
                  <Button
                    variant="quiet"
                    onClick={() =>
                      setDoc({
                        ...doc,
                        parts: (doc.parts ?? []).filter((part) => part.label !== leaf.key),
                      })
                    }
                  >
                    Remove part
                  </Button>
                ) : null}
              </div>
            ) : null}
            {leaf.key ? (
              <div className="mb-4">
                <Textarea
                  label="This part's prompt"
                  rows={3}
                  disabled={!editable}
                  value={(doc.parts ?? []).find((part) => part.label === leaf.key)?.prompt_md ?? ''}
                  onChange={(event) =>
                    setDoc({
                      ...doc,
                      parts: (doc.parts ?? []).map((part) =>
                        part.label === leaf.key ? { ...part, prompt_md: event.target.value } : part,
                      ),
                    })
                  }
                />
              </div>
            ) : null}
            {verified && verification.runs[leaf.key]?.compile_error ? (
              <div className="mb-4">
                <Notice tone="not-yet">
                  The solution does not run: {verification.runs[leaf.key]?.compile_error}
                </Notice>
              </div>
            ) : null}
            <LeafEditor
              editorKey={`${loaded?.id ?? 'new'}-${loaded?.version ?? 0}-${leaf.key}`}
              leaf={leaf.leaf}
              concepts={concepts.data}
              disabled={!editable}
              results={verified ? (verification.runs[leaf.key]?.results ?? null) : null}
              onChange={(next) => setLeaf(leaf.key, next)}
            />
          </Card>
        ))
      ) : (
        <Spinner label="Loading concepts" />
      )}

      {editable && !isMcq ? (
        <div className="mb-6 flex flex-wrap gap-2">
          {(doc.parts ?? []).length === 0 ? (
            <Button variant="secondary" onClick={splitIntoParts}>
              Split into parts (a, b, c)
            </Button>
          ) : (
            <Button
              variant="secondary"
              disabled={nextPartLabel(doc.parts ?? []) === null}
              onClick={() => {
                const label = nextPartLabel(doc.parts ?? [])
                if (label) setDoc({ ...doc, parts: [...(doc.parts ?? []), emptyPart(label)] })
              }}
            >
              Add a part
            </Button>
          )}
        </div>
      ) : null}

      {editable ? (
        <Card className="sticky bottom-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" disabled={busy || !dirty} onClick={() => void persist()}>
              {create.isPending || save.isPending ? 'Saving…' : dirty ? 'Save draft' : 'Saved'}
            </Button>
            {isMcq ? null : (
              <Button
                variant="secondary"
                disabled={busy || pythonUnavailable}
                onClick={() => void checkSolution()}
              >
                {checking ? 'Checking…' : 'Check solution'}
              </Button>
            )}
            <Button
              variant="primary"
              disabled={
                (!isMcq && !allPass) || dirty || gaps.length > 0 || publish.isPending || !loaded
              }
              onClick={() => loaded && publish.mutate(loaded.updated_at)}
            >
              Publish
            </Button>
            {loaded ? (
              <Button variant="quiet" onClick={() => setConfirmArchive(true)}>
                Archive draft
              </Button>
            ) : null}
            <span className="text-sm text-muted">
              {isMcq
                ? dirty
                  ? 'Save the question, then publish.'
                  : ''
                : pythonUnavailable
                ? 'Python is not available in this browser, so the solution cannot be checked.'
                : verified
                  ? allPass
                    ? 'The solution passes every check.'
                    : 'The solution does not pass every check yet.'
                  : 'Check the solution against its tests before publishing.'}
            </span>
          </div>
          {warnings.length > 0 ? (
            <p className="mt-3 text-sm text-muted">{warnings.join(' · ')}</p>
          ) : null}
          {gaps.length > 0 ? (
            <ul className="mt-3 list-disc pl-5 text-sm text-grape">
              {gaps.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}

      <Dialog
        open={confirmArchive}
        title="Archive this problem?"
        onClose={() => setConfirmArchive(false)}
        confirm={{
          label: 'Archive',
          onConfirm: () => {
            setConfirmArchive(false)
            archive.mutate(undefined)
          },
        }}
      >
        It leaves the bank, so it cannot be added to new sets. Sets that already use it keep
        it, and you can bring it back later.
      </Dialog>
    </>
  )
}
