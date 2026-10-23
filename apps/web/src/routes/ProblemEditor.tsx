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
 *
 * Since 17 Oct 2026 (Ken): splitting into parts makes **one file** for them all — the
 * starter and solution stay on the problem, every part's checks run against the whole
 * file — and a problem or part can have **examples**, sample runs of the solution that a
 * child watches. Check solution runs those too, and Publish sends what they printed.
 * "Preview as student" opens the problem as a child would see it, from what is on screen.
 */

import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card, PageHeader } from '../components/Card'
import { Dialog } from '../components/Dialog'
import { TrashDialog } from '../components/TrashDialog'
import { DotsPicker } from '../components/Dots'
import { TextInput } from '../components/Field'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { api, type Schemas } from '../lib/api'
import { messageFor } from '../lib/errors'
import { useConcepts, useProblem, useProblemMutation, useTrashAction } from '../lib/queries'
import {
  emptyPart,
  emptyProblem,
  isSharedFile,
  leavesOf,
  nextPartLabel,
  type LeafDoc,
  type ProblemDoc,
} from '../problems/doc'
import { ConceptPicker } from '../problems/ConceptPicker'
import { ExamplesEditor } from '../problems/ExamplesEditor'
import { CodeBox, LeafEditor } from '../problems/LeafEditor'
import { McqEditor } from '../problems/McqEditor'
import { PromptField } from '../problems/PromptField'
import { StudentPreview } from '../problems/StudentPreview'
import { runPassed, transcriptsOf, verifyProblem, type Verification } from '../problems/verify'
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
  const [studentPreview, setStudentPreview] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmNoChecks, setConfirmNoChecks] = useState(false)
  const trash = useTrashAction()

  const create = useProblemMutation((body: ProblemDoc) => api.createProblem(body))
  const save = useProblemMutation((body: ProblemDoc) => api.saveProblem(itemId ?? '', body))
  const publish = useProblemMutation((run: Verification | { updatedAt: string }) =>
    api.publishProblem(itemId ?? '', run.updatedAt, 'examples' in run ? transcriptsOf(run) : {}),
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
  const allPass =
    verified &&
    leaves.every((leaf) => runPassed(verification.runs[leaf.key])) &&
    Object.values(verification.examples).every((runs) => runs.every((run) => run !== null))
  const shared = doc ? isSharedFile(doc) : false
  const exampleRuns = (key: string) => (verified ? verification.examples[key] : undefined)
  const gaps = loaded && !dirty ? loaded.publish_problems : []
  const warnings = loaded && !dirty ? loaded.publish_warnings : []
  // A code problem with no checks can't tell a child whether they're right. Allowed —
  // drawing and games are open-ended — but asked about first (Ken, 23 Oct 2026).
  const noChecks = doc?.kind !== 'mcq' && leaves.some((l) => (l.leaf.tests ?? []).length === 0)
  function publishNow() {
    if (loaded) publish.mutate(doc?.kind === 'mcq' || !verification ? { updatedAt: loaded.updated_at } : verification)
  }
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
      setVerification(await verifyProblem(python, saved))
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
   * Splitting a problem makes its parts one file (Ken, 17 Oct 2026): the starter, the
   * solution and the examples stay on the problem, and what is checked moves into part
   * (a) — tests left on the parent would be refused at publish.
   */
  function splitIntoParts() {
    setDoc((current) => {
      if (!current) return current
      const { difficulty, concept_ids, primary_concept_id, tests, hints } = current
      return {
        ...current,
        shared_file: true,
        concept_ids: [],
        primary_concept_id: null,
        tests: [],
        hints: [],
        parts: [{ ...emptyPart('a'), difficulty, concept_ids, primary_concept_id, tests, hints }],
      }
    })
  }

  /**
   * An older problem with code per part, made one file: part (a)'s starter, the last
   * part's solution (later parts build on earlier ones), and the parts' examples kept.
   */
  function shareOneFile() {
    setDoc((current) => {
      if (!current) return current
      const parts = current.parts ?? []
      return {
        ...current,
        shared_file: true,
        starter_code: parts[0]?.starter_code ?? '',
        solution_code: parts.at(-1)?.solution_code ?? '',
        parts: parts.map((part) => ({ ...part, starter_code: '', solution_code: '' })),
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
              {itemId ? (
                <Button variant="quiet" onClick={() => setConfirmDelete(true)}>
                  Delete
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
          <PromptField
            name="Prompt"
            label="What the student reads (markdown: `code`, **bold**, lists)"
            value={doc.prompt_md ?? ''}
            editable={editable}
            onChange={(prompt_md) => setDoc({ ...doc, prompt_md })}
          />
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
        <>
        {shared ? (
          <Card className="mb-6">
            <h2 className="mb-1 font-display font-semibold text-xl text-grape">The file</h2>
            <p className="mb-4 text-sm text-muted">
              One program for every part. Students write all the parts in it, and each
              part&rsquo;s checks run against the whole file.
            </p>
            {verified && verification.runs[leaves[0]?.key ?? '']?.compile_error ? (
              <div className="mb-4">
                <Notice tone="not-yet">
                  The solution does not run: {verification.runs[leaves[0]?.key ?? '']?.compile_error}
                </Notice>
              </div>
            ) : null}
            <div className="grid gap-4 lg:grid-cols-2">
              <CodeBox
                key={`${loaded?.id ?? 'new'}-${loaded?.version ?? 0}-file-starter`}
                label="Starter code"
                hint="what the student begins with"
                value={doc.starter_code ?? ''}
                readOnly={!editable}
                onChange={(starter_code) => setDoc({ ...doc, starter_code })}
              />
              <CodeBox
                key={`${loaded?.id ?? 'new'}-${loaded?.version ?? 0}-file-solution`}
                label="Reference solution"
                hint="all the parts done — never shown to students"
                value={doc.solution_code ?? ''}
                readOnly={!editable}
                onChange={(solution_code) => setDoc({ ...doc, solution_code })}
              />
            </div>
            <section className="mt-5">
              <h3 className="mb-2 font-display font-semibold text-lg text-grape">
                How the finished program should run
              </h3>
              <ExamplesEditor
                examples={doc.examples ?? []}
                runs={exampleRuns('')}
                disabled={!editable}
                of="the finished program"
                onChange={(examples) => setDoc({ ...doc, examples })}
              />
            </section>
          </Card>
        ) : null}
        {leaves.map((leaf) => (
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
                <PromptField
                  name="This part's prompt"
                  label="What the student reads for this part (markdown)"
                  rows={3}
                  editable={editable}
                  value={(doc.parts ?? []).find((part) => part.label === leaf.key)?.prompt_md ?? ''}
                  onChange={(prompt_md) =>
                    setDoc({
                      ...doc,
                      parts: (doc.parts ?? []).map((part) =>
                        part.label === leaf.key ? { ...part, prompt_md } : part,
                      ),
                    })
                  }
                />
              </div>
            ) : null}
            {verified && !shared && verification.runs[leaf.key]?.compile_error ? (
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
              codeless={shared}
              exampleRuns={exampleRuns(leaf.key)}
              onChange={(next) => setLeaf(leaf.key, next)}
            />
          </Card>
        ))}
        </>
      ) : (
        <Spinner label="Loading concepts" />
      )}

      {editable && !isMcq ? (
        <div className="mb-6 flex flex-wrap gap-2">
          {(doc.parts ?? []).length > 0 && !shared ? (
            <Button variant="secondary" onClick={shareOneFile}>
              Use one file for all parts
            </Button>
          ) : null}
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
              onClick={() => (noChecks ? setConfirmNoChecks(true) : publishNow())}
            >
              Publish
            </Button>
            {isMcq ? null : (
              <Button variant="secondary" onClick={() => setStudentPreview(true)}>
                Preview as student
              </Button>
            )}
            {loaded ? (
              <Button variant="quiet" onClick={() => setConfirmArchive(true)}>
                Archive draft
              </Button>
            ) : null}
            {loaded ? (
              <Button variant="quiet" onClick={() => setConfirmDelete(true)}>
                Delete
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

      {!isMcq ? (
        <StudentPreview
          open={studentPreview}
          onClose={() => setStudentPreview(false)}
          doc={doc}
          runs={verified ? verification.examples : null}
          python={python}
        />
      ) : null}

      {!editable && !isMcq ? (
        <div className="mb-6">
          <Button variant="secondary" onClick={() => setStudentPreview(true)}>
            Preview as student
          </Button>
        </div>
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

      <Dialog
        open={confirmNoChecks}
        title="Publish without checks?"
        onClose={() => setConfirmNoChecks(false)}
        confirm={{
          label: 'Publish anyway',
          onConfirm: () => {
            setConfirmNoChecks(false)
            publishNow()
          },
        }}
      >
        {leaves.length > 1 ? 'A part of this problem has' : 'This problem has'} no checks, so
        children can Run it but can’t see whether they’re right. That suits open-ended work
        like drawings or games.
      </Dialog>

      <TrashDialog
        open={confirmDelete}
        name="this problem"
        note="A problem still in a lesson, homework or quiz can’t be deleted: take it out of there first, or archive it instead."
        busy={trash.isPending}
        error={trash.error ? messageFor(trash.error) : null}
        onClose={() => {
          trash.reset()
          setConfirmDelete(false)
        }}
        onConfirm={() =>
          trash.mutate(
            { action: 'trash', kind: 'problem', id: itemId ?? '' },
            { onSuccess: () => navigate('/problems') },
          )
        }
      />
    </>
  )
}
