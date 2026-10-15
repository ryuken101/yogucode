/**
 * Where a student writes and runs Python.
 *
 * Their files are tabs, their work saves itself, and the editor reopens whatever they were
 * last in — which is product-spec §3.1's actual promise: "work persists across sessions,
 * no lost files between weeks."
 *
 * Both panels are dark, a deliberately *considered* dark — the brand's `night` rather than
 * VS Code's. The page stays cream around them.
 *
 * This is free coding — "write a program that prints your name". Problems, with their
 * checks and hints, live in `ProblemAttempt` and save to attempts rather than to files.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Button } from '../components/Button'
import { Console } from '../components/Console'
import { FileExplorer } from '../components/FileExplorer'
import { FileTabs } from '../components/FileTabs'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { CodeSurface } from '../editor/CodeSurface'
import { useAutosave } from '../editor/useAutosave'
import { useOpenTabs } from '../editor/useOpenTabs'
import { messageFor } from '../lib/errors'
import { isPythonFile, languageOf } from '../lib/fileType'
import {
  useArchiveDocument,
  useCreateDocument,
  useDocument,
  useDocuments,
  useFolderActions,
  useFolders,
  useRenameDocument,
} from '../lib/queries'
import { studentLive } from '../collab/socket'
import { useLiveDoc } from '../collab/useLiveDoc'
import { useEventRecorder } from '../events/recorder'
import { usePython } from '../runtime/usePython'

export function Work() {
  const files = useDocuments()
  const folders = useFolders('me')
  const folderActions = useFolderActions('me')
  const create = useCreateDocument()
  const archive = useArchiveDocument()
  const rename = useRenameDocument()

  // The autosave needs the open file, and switching files needs the autosave's flush:
  // a ref breaks the loop, updated after render.
  const flushRef = useRef<() => void>(() => {})
  const flush = useCallback(() => flushRef.current(), [])
  const { tabs, activeId, open, close } = useOpenTabs(files.data, flush)
  const active = useDocument(activeId)
  const autosave = useAutosave(activeId)
  useEffect(() => {
    flushRef.current = autosave.flush
  })
  // My files are recorded too, by Ken's decision (Phase 5 planning): edits, runs, errors.
  const record = useEventRecorder(activeId ? { documentId: activeId } : null)
  const { state, output, run, stop, answer } = usePython({
    onRunFinished: ({ ok, interrupted, stderr }) => {
      if (!ok && !interrupted) {
        record('error', { text: stderr.slice(-2000) })
        studentLive().status({ kind: 'error', text: stderr.trim().split('\n').pop() ?? '' })
      }
    },
  })
  // The live classroom: this file's text streams to the teacher, who can type into it.
  const target = activeId ? `document:${activeId}` : null
  const live = useLiveDoc(target, active.data ? active.data.content : null)
  // Shown on the teacher's tile as "week 1 / squares", so they know which file it is.
  const fileTitle = active.data ? pathOf(active.data, folders.data ?? []) : null
  useEffect(() => {
    studentLive().setFocus(target && fileTitle ? { target, kind: 'file', title: fileTitle } : null)
  }, [target, fileTitle])

  /**
   * Reopen whatever they were last editing — once, when the page loads.
   *
   * The list comes back ordered by `updated_at`, so the first file is the one they left
   * off in. A child mid-task last week simply carries on.
   */
  const [started, setStarted] = useState(false)
  useEffect(() => {
    if (started || !files.data) return
    setStarted(true)
    if (files.data.length > 0) {
      open(files.data[0]!.id)
    } else {
      // A brand-new student has nothing to reopen. The server supplies the starter
      // content, so "what a new file contains" is defined in one place.
      create.mutate(null, { onSuccess: (created) => open(created.id) })
    }
  }, [started, files.data, create, open])

  // A file chosen in the Files app or in search arrives as `?open=<id>` (16 Oct 2026).
  const [params] = useSearchParams()
  const wanted = params.get('open')
  useEffect(() => {
    if (wanted && files.data?.some((f) => f.id === wanted)) open(wanted)
  }, [wanted, files.data, open])

  // Tell the autosave what the server already has, so opening a file does not save it
  // straight back.
  useEffect(() => {
    if (active.data) autosave.adopt(active.data.id, active.data.content)
    // `adopt` is stable; depending on the whole hook would re-run on every save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.data?.id, active.data?.content])

  const explorer = (
    <FileExplorer
      files={files.data ?? []}
      folders={folders.data ?? []}
      activeId={activeId}
      onOpen={open}
      onCreateFile={(folderId) =>
        create.mutate(folderId, { onSuccess: (created) => open(created.id) })
      }
      onCreateFolder={(name, parentId) => folderActions.create.mutate({ name, parentId })}
      onRenameFile={(id, title) => rename.mutate({ documentId: id, title })}
      onRenameFolder={(folderId, name) => folderActions.update.mutate({ folderId, name })}
      onMove={(item, folderId) =>
        item.kind === 'file'
          ? folderActions.moveFile.mutate({ documentId: item.id, folderId })
          : folderActions.update.mutate({ folderId: item.id, parent_id: folderId })
      }
      onDeleteFile={(id) => archive.mutate(id)}
      onDeleteFolder={(folderId) => folderActions.remove.mutate(folderId)}
      busy={create.isPending}
    />
  )
  const folderError =
    folderActions.create.error ??
    folderActions.update.error ??
    folderActions.moveFile.error ??
    folderActions.remove.error

  const busy = state.status === 'running' || state.status === 'asking'
  const loading = state.status === 'loading'
  const code = active.data?.content ?? ''
  // A file's type is its name, as in VS Code: only .py runs (lib/fileType.ts).
  const python = isPythonFile(active.data?.title)

  if (state.status === 'unsupported') {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16">
        <Notice tone="system-error">{state.reason}</Notice>
      </div>
    )
  }

  return (
    <div className="flex h-full gap-3 p-3">
      {/* The explorer: folders and files, VS Code style (Ken's decision, 11 Oct 2026). */}
      <aside className="hidden w-56 shrink-0 sm:block">{explorer}</aside>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button
          variant="primary"
          onClick={() => {
            run(code)
            record('run')
            studentLive().status({ kind: 'run' })
          }}
          disabled={busy || loading || !python}
          title={python ? undefined : 'Only .py files can run'}
        >
          {busy ? 'Running…' : 'Run'}
        </Button>
        {/* Not a danger variant: stopping your own program destroys nothing. */}
        <Button variant="secondary" onClick={stop} disabled={!busy}>
          Stop
        </Button>
        {loading ? <Spinner label={state.detail} /> : null}
        {state.status === 'asking' ? (
          <span className="text-sm text-not-yet-ink">Your program is waiting for you to type.</span>
        ) : null}
        <span className="ml-auto text-xs text-muted" aria-live="polite">
          {autosave.state === 'saving' ? 'Saving…' : null}
          {autosave.state === 'saved' ? 'Saved' : null}
        </span>
      </div>

      {/* A failed save is the one thing here that is genuinely our problem rather than
          something the child did, so it is the one thing allowed to be system-error. */}
      {autosave.state === 'failed' ? (
        <Notice tone="system-error">
          Your work is not saving. Tell your teacher — you may need to sign in again.
        </Notice>
      ) : null}

      {/* Two live files cannot share a name — the API refuses with a 409 and a sentence
          written for a child. Not-yet, not system-error: renaming to something else fixes it, so it
          is "not yet" rather than a fault. Without this the tab simply reverted and
          nothing explained why. TanStack clears the error on the next attempt. */}
      {rename.error ? <Notice tone="not-yet">{messageFor(rename.error)}</Notice> : null}

      {folderError ? <Notice tone="not-yet">{messageFor(folderError)}</Notice> : null}
      {active.data && !python ? (
        <Notice tone="info">
          This is a text file. Only files whose names end in <span className="font-mono">.py</span>{' '}
          can run — rename it to add <span className="font-mono">.py</span>.
        </Notice>
      ) : null}

      <FileTabs
        files={tabs}
        activeId={activeId}
        onSelect={open}
        onCreate={() =>
          create.mutate(active.data?.folder_id ?? null, {
            onSuccess: (created) => open(created.id),
          })
        }
        onClose={close}
        onRename={(id, title) => rename.mutate({ documentId: id, title })}
        busy={create.isPending}
      />

      {/* The editor gets roughly two thirds; the terminal is legible at a third and grows
          when there is room. min-h-0 is what lets both scroll instead of overflowing. */}
      {live.locked ? (
        <Notice tone="info">
          Your teacher is helping — watch your code. You can type again when they’re done.
        </Notice>
      ) : null}

      <div className="min-h-0 flex-[2] overflow-hidden rounded-b-lg rounded-tr-lg ring-1 ring-grape/25">
        {!activeId && started && !create.isPending ? (
          <div className="flex h-full items-center justify-center bg-night p-6 text-center text-cream/70">
            Open a file from the list on the left, or press + File to start a new one.
          </div>
        ) : active.isPending && activeId ? (
          <div className="flex h-full items-center justify-center bg-night">
            <Spinner label="Opening your file" />
          </div>
        ) : (
          <CodeSurface
            // Remount on file change: Monaco keeps its own undo stack per model, and
            // carrying one file's history into another would let Ctrl-Z paste the wrong
            // program into a child's work.
            key={activeId ?? 'none'}
            value={code}
            // Locked while the teacher helps (Ken's decision, 11 Oct 2026).
            readOnly={live.locked}
            language={languageOf(active.data?.title)}
            onChange={autosave.onChange}
            onModel={live.bind}
            onCursor={live.onCursor}
            onEdit={(changes) => record(live.isRemote() ? 'teacher_edit' : 'edit', { changes })}
            onPaste={(chars) => {
              record('paste', { chars })
              studentLive().status({ kind: 'paste', chars })
            }}
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
    </div>
  )
}

/** "week 1 / loops / squares" — where a file sits, for the teacher's live tile. */
function pathOf(
  file: { title: string; folder_id?: string | null },
  folders: { id: string; name: string; parent_id?: string | null }[],
): string {
  const parts = [file.title]
  let at = file.folder_id ?? null
  for (let depth = 0; at && depth < 20; depth++) {
    const folder = folders.find((f) => f.id === at)
    if (!folder) break
    parts.unshift(folder.name)
    at = folder.parent_id ?? null
  }
  return parts.join(' / ')
}
