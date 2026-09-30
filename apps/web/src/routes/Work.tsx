/**
 * Where a student writes and runs Python.
 *
 * Their files are tabs, their work saves itself, and the editor reopens whatever they were
 * last in — which is product-spec §3.1's actual promise: "work persists across sessions,
 * no lost files between weeks."
 *
 * Both panels are dark, a deliberately *considered* dark built from the §8 palette rather
 * than VS Code's, which is what §8 asks for. The page stays cream around them.
 *
 * There are no problems on screen yet; those are Phase 4. Until then this is usable
 * classwork on its own: the teacher says "write a program that prints your name", and a
 * child does exactly that.
 */

import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Console } from '../components/Console'
import { FileTabs } from '../components/FileTabs'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { CodeSurface } from '../editor/CodeSurface'
import { useAutosave } from '../editor/useAutosave'
import { messageFor } from '../lib/errors'
import {
  useArchiveDocument,
  useCreateDocument,
  useDocument,
  useDocuments,
  useRenameDocument,
} from '../lib/queries'
import { usePython } from '../runtime/usePython'

export function Work() {
  const { state, output, run, stop, answer } = usePython()
  const files = useDocuments()
  const create = useCreateDocument()
  const archive = useArchiveDocument()
  const rename = useRenameDocument()

  const [activeId, setActiveId] = useState<string | null>(null)
  const active = useDocument(activeId)
  const autosave = useAutosave(activeId)

  /**
   * Reopen whatever they were last editing.
   *
   * The list comes back ordered by `updated_at`, so the first tab is the one they left
   * off in. A child mid-task last week simply carries on.
   */
  useEffect(() => {
    if (activeId !== null || !files.data) return
    if (files.data.length > 0) {
      setActiveId(files.data[0]!.id)
    } else if (!create.isPending && !create.isSuccess) {
      // A brand-new student has nothing to reopen. The server supplies the starter
      // content, so "what a new file contains" is defined in one place.
      create.mutate(undefined, { onSuccess: (created) => setActiveId(created.id) })
    }
  }, [activeId, files.data, create])

  // Tell the autosave what the server already has, so opening a file does not save it
  // straight back.
  useEffect(() => {
    if (active.data) autosave.adopt(active.data.id, active.data.content)
    // `adopt` is stable; depending on the whole hook would re-run on every save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.data?.id, active.data?.content])

  function switchTo(documentId: string) {
    // Flush before leaving, or the last couple of seconds of typing vanish at exactly the
    // moment a child thinks they have finished with a file.
    autosave.flush()
    setActiveId(documentId)
  }

  const busy = state.status === 'running' || state.status === 'asking'
  const loading = state.status === 'loading'
  const code = active.data?.content ?? ''

  if (state.status === 'unsupported') {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16">
        <Notice tone="system-error">{state.reason}</Notice>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => run(code)} disabled={busy || loading}>
          {busy ? 'Running…' : 'Run'}
        </Button>
        {/* Not a danger variant: stopping your own program destroys nothing. */}
        <Button variant="secondary" onClick={stop} disabled={!busy}>
          Stop
        </Button>
        {loading ? <Spinner label={state.detail} /> : null}
        {state.status === 'asking' ? (
          <span className="text-sm text-amber">Your program is waiting for you to type.</span>
        ) : null}
        <span className="ml-auto text-xs text-ink-soft" aria-live="polite">
          {autosave.state === 'saving' ? 'Saving…' : null}
          {autosave.state === 'saved' ? 'Saved' : null}
        </span>
      </div>

      {/* A failed save is the one thing here that is genuinely our problem rather than
          something the child did, so it is the one thing allowed to be rust. */}
      {autosave.state === 'failed' ? (
        <Notice tone="system-error">
          Your work is not saving. Tell your teacher — you may need to sign in again.
        </Notice>
      ) : null}

      {/* Two live files cannot share a name — the API refuses with a 409 and a sentence
          written for a child. Amber, not rust: renaming to something else fixes it, so it
          is "not yet" rather than a fault. Without this the tab simply reverted and
          nothing explained why. TanStack clears the error on the next attempt. */}
      {rename.error ? <Notice tone="not-yet">{messageFor(rename.error)}</Notice> : null}

      <FileTabs
        files={files.data ?? []}
        activeId={activeId}
        onSelect={switchTo}
        onCreate={() =>
          create.mutate(undefined, { onSuccess: (created) => switchTo(created.id) })
        }
        onClose={(id) =>
          archive.mutate(id, {
            onSuccess: () => {
              if (id !== activeId) return
              const next = (files.data ?? []).find((file) => file.id !== id)
              setActiveId(next?.id ?? null)
            },
          })
        }
        onRename={(id, title) => rename.mutate({ documentId: id, title })}
        busy={create.isPending}
      />

      {/* The editor gets roughly two thirds; the terminal is legible at a third and grows
          when there is room. min-h-0 is what lets both scroll instead of overflowing. */}
      <div className="min-h-0 flex-[2] overflow-hidden rounded-b-lg rounded-tr-lg ring-1 ring-ink/20">
        {active.isPending && activeId ? (
          <div className="flex h-full items-center justify-center bg-ink-deep">
            <Spinner label="Opening your file" />
          </div>
        ) : (
          <CodeSurface
            // Remount on file change: Monaco keeps its own undo stack per model, and
            // carrying one file's history into another would let Ctrl-Z paste the wrong
            // program into a child's work.
            key={activeId ?? 'none'}
            value={code}
            onChange={autosave.onChange}
          />
        )}
      </div>
      <div className="min-h-0 flex-1">
        <Console segments={output} asking={state.status === 'asking'} onAnswer={answer} />
      </div>

      {files.error ? (
        <Notice tone="system-error">{messageFor(files.error)}</Notice>
      ) : null}
    </div>
  )
}
