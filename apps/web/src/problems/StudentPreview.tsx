/**
 * "Preview as student" (Ken's decision, 17 Oct 2026): the problem as a child will meet it —
 * prompt, parts, how it should run, the starter code, Run and Check — from what is in the
 * editor right now, saved or not.
 *
 * It is a sandbox: nothing is saved, nothing is recorded, and nobody is told. The
 * description and checks are the attempt page's own components (`ProblemBrief`,
 * `ChecksPanel`), so a teacher previews what a child will see rather than an imitation.
 * Examples show the runs from the last Check solution, or the published ones.
 */

import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { Console } from '../components/Console'
import { CodeSurface } from '../editor/CodeSurface'
import type { ExamplePiece, ExampleRun, TestRun } from '../runtime/protocol'
import type { usePython } from '../runtime/usePython'
import { ChecksPanel } from './ChecksPanel'
import { isSharedFile, leavesOf, solutionOf, toChecks, type ExampleDoc, type ProblemDoc } from './doc'
import { ProblemBrief } from './ProblemBrief'

interface Props {
  open: boolean
  onClose: () => void
  doc: ProblemDoc
  /** The last Check solution's example runs, by leaf key. */
  runs: Record<string, (ExampleRun | null)[]> | null
  python: ReturnType<typeof usePython>
}

/** What a child would be shown for these examples: this browser's runs, else the stored. */
function shownExamples(examples: ExampleDoc[] | undefined, runs: (ExampleRun | null)[] | undefined): ExamplePiece[][] {
  return (examples ?? []).map((example, index) => runs?.[index]?.transcript ?? example.transcript ?? [])
}

export function StudentPreview({ open, onClose, doc, runs, python }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const shared = isSharedFile(doc)
  const leaves = leavesOf(doc)
  const [active, setActive] = useState(0)
  const [code, setCode] = useState<Record<string, string>>({})
  const [results, setResults] = useState<Record<string, TestRun | null>>({})

  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (open && !node.open) {
      // A fresh child each time: starter code, no results.
      setActive(0)
      setCode({})
      setResults({})
      node.showModal()
    }
    if (!open && node.open) node.close()
  }, [open])

  const leaf = leaves[Math.min(active, leaves.length - 1)]!
  const codeKey = shared ? 'file' : leaf.key
  const starter = shared || leaf.key === '' ? (doc.starter_code ?? '') : (leaf.leaf.starter_code ?? '')
  const current = code[codeKey] ?? starter
  const status = python.state.status
  const busy = ['running', 'asking', 'checking'].includes(status)
  const parts = doc.parts ?? []

  return (
    <dialog
      ref={ref}
      aria-label="Preview as student"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      className="m-auto h-[min(48rem,calc(100vh-2rem))] w-[min(80rem,calc(100vw-2rem))] rounded-3xl bg-cream p-0 text-grape backdrop:bg-night/40"
    >
      {open ? (
        <div className="flex h-full flex-col">
          <div className="flex shrink-0 items-center gap-3 border-b border-line bg-surface px-4 py-2">
            <h2 className="font-display text-lg font-semibold text-grape">Preview as student</h2>
            <span className="text-sm text-muted">Nothing here is saved.</span>
            <span className="flex-1" />
            <Button variant="secondary" onClick={onClose}>
              Close preview
            </Button>
          </div>
          <div className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-[2fr_3fr]">
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto rounded-lg bg-surface p-4 ring-1 ring-line">
              <ProblemBrief
                title={doc.title || 'New problem'}
                difficulty={doc.difficulty}
                prompt_md={doc.prompt_md ?? ''}
                examples={
                  parts.length === 0 || shared ? shownExamples(doc.examples, runs?.['']) : []
                }
                parts={
                  parts.length === 0
                    ? [{ key: 'whole', label: null, prompt_md: '', examples: [] }]
                    : parts.map((part) => ({
                        key: part.label,
                        label: part.label,
                        prompt_md: part.prompt_md ?? '',
                        examples: shownExamples(part.examples, runs?.[part.label]),
                      }))
                }
                active={active}
                onSelect={setActive}
              />
              <ChecksPanel
                enabled
                count={(leaf.leaf.tests ?? []).length}
                run={results[leaf.key]}
                sharedFile={shared}
              />
            </div>
            <div className="flex min-h-0 flex-col gap-2">
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Button variant="primary" onClick={() => python.run(current)} disabled={busy || status === 'loading'}>
                  {status === 'running' || status === 'asking' ? 'Running…' : 'Run'}
                </Button>
                <Button variant="secondary" onClick={python.stop} disabled={!busy}>
                  Stop
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy || status === 'loading'}
                  onClick={async () => {
                    const outcome = await python.check(current, toChecks(leaf.leaf.tests, { solution: solutionOf(doc, leaf.leaf) }))
                    setResults((now) => ({ ...now, [leaf.key]: outcome }))
                  }}
                >
                  {status === 'checking' ? 'Checking…' : 'Check'}
                </Button>
              </div>
              <div className="min-h-48 flex-[2] overflow-hidden rounded-lg ring-1 ring-grape/25">
                <CodeSurface
                  key={codeKey}
                  value={current}
                  onChange={(next) => setCode((now) => ({ ...now, [codeKey]: next }))}
                />
              </div>
              <div className="min-h-32 flex-1">
                <Console segments={python.output} asking={status === 'asking'} onAnswer={python.answer} />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </dialog>
  )
}
