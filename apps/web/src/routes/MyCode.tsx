/**
 * My code: a teacher's own files, for demonstrating on the projector (Ken's decisions,
 * 10 Oct 2026).
 *
 * The same editor, terminal, tabs and autosave as a child's My files (`Work.tsx`), built
 * from the same components — but none of the classroom wiring: nothing streams to the live
 * view and nothing is recorded as events. The files are private to this teacher
 * (`/teacher/documents`, scoped to the signed-in user on the server).
 *
 * **Present** fills the screen with the code and its output at a size the back row can
 * read: the menus and tabs go, the editor text goes from 15px to 24px, and Run / Stop /
 * Exit stay in a thin bar. It uses the browser's full-screen mode where it can, and a
 * full-window overlay where it cannot; Esc or Exit leaves either.
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
import { SaveControl } from '../editor/SaveControl'
import { useAutosave } from '../editor/useAutosave'
import { useOpenTabs } from '../editor/useOpenTabs'
import { messageFor } from '../lib/errors'
import { isPythonFile, languageOf } from '../lib/fileType'
import {
  useArchiveTeacherDocument,
  useCreateTeacherDocument,
  useFolderActions,
  useFolders,
  useRenameTeacherDocument,
  useSaveTeacherDocument,
  useTeacherDocument,
  useTeacherDocuments,
} from '../lib/queries'
import { usePython } from '../runtime/usePython'

/** Editor text size while presenting. Big enough for the back of a classroom. */
const PRESENT_FONT_SIZE = 24

export function MyCode() {
  const files = useTeacherDocuments()
  const create = useCreateTeacherDocument()
  const archive = useArchiveTeacherDocument()
  const rename = useRenameTeacherDocument()
  const save = useSaveTeacherDocument()

  const folders = useFolders('teacher')
  const folderActions = useFolderActions('teacher')

  // As on My files: switching files needs the autosave's flush, which needs the open file.
  const flushRef = useRef<() => void>(() => {})
  const flush = useCallback(() => flushRef.current(), [])
  const { tabs, activeId, open, close } = useOpenTabs(files.data, flush)
  const active = useTeacherDocument(activeId)
  const autosave = useAutosave(activeId, (id, content) =>
    save.mutateAsync({ documentId: id, content }),
  )
  useEffect(() => {
    flushRef.current = autosave.flush
  })
  const { state, output, run, stop, answer } = usePython()

  const [presenting, setPresenting] = useState(false)
  const stage = useRef<HTMLDivElement>(null)

  // Reopen whatever was last edited, once; a first visit gets a starter file.
  const [started, setStarted] = useState(false)
  useEffect(() => {
    if (started || !files.data) return
    setStarted(true)
    if (files.data.length > 0) open(files.data[0]!.id)
    else create.mutate(null, { onSuccess: (created) => open(created.id) })
  }, [started, files.data, create, open])

  // A file chosen in the Files app or in search arrives as `?open=<id>` (16 Oct 2026).
  const [params] = useSearchParams()
  const wanted = params.get('open')
  useEffect(() => {
    if (wanted && files.data?.some((f) => f.id === wanted)) open(wanted)
  }, [wanted, files.data, open])

  useEffect(() => {
    if (active.data) autosave.adopt(active.data.id, active.data.content)
    // `adopt` is stable; depending on the whole hook would re-run on every save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.data?.id, active.data?.content])

  // Leaving full screen with Esc (the browser's own key) must leave Present mode too.
  useEffect(() => {
    function onChange() {
      if (!document.fullscreenElement) setPresenting(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // The overlay fallback has no browser Esc handling of its own.
  useEffect(() => {
    if (!presenting) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !document.fullscreenElement) setPresenting(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [presenting])

  function startPresenting() {
    setPresenting(true)
    // Full screen where the browser allows it; otherwise the overlay alone is the fallback.
    stage.current?.requestFullscreen?.().catch(() => undefined)
  }

  function stopPresenting() {
    setPresenting(false)
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
  }

  const folderError =
    folderActions.create.error ??
    folderActions.update.error ??
    folderActions.moveFile.error ??
    folderActions.remove.error

  const busy = state.status === 'running' || state.status === 'asking'
  const loading = state.status === 'loading'
  const code = active.data?.content ?? ''
  const python = isPythonFile(active.data?.title)

  if (state.status === 'unsupported') {
    return <Notice tone="system-error">{state.reason}</Notice>
  }

  const runButtons = (
    <>
      <Button
        variant="primary"
        onClick={() => run(code)}
        disabled={busy || loading || !python}
        title={python ? undefined : 'Only .py files can run'}
      >
        {busy ? 'Running…' : 'Run'}
      </Button>
      <Button variant="secondary" onClick={stop} disabled={!busy}>
        Stop
      </Button>
      {loading ? <Spinner label={state.detail} /> : null}
    </>
  )

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
      restoreNote=""
    />
  )

  return (
    <div
      ref={stage}
      className={
        presenting
          ? 'fixed inset-0 z-50 flex flex-col gap-3 bg-night p-4'
          : 'flex h-full min-h-0 gap-3 p-3'
      }
    >
      {/* The explorer, hidden while presenting so the code fills the projector. */}
      {!presenting ? (
        <aside className="hidden w-52 shrink-0 sm:block lg:w-60">{explorer}</aside>
      ) : null}
      <div className={presenting ? 'contents' : 'flex min-w-0 flex-1 flex-col gap-2'}>
      {presenting ? (
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <span className="font-display text-xl font-semibold text-cream">
            {active.data?.title ?? ''}
          </span>
          {runButtons}
          <Button variant="secondary" className="ml-auto" onClick={stopPresenting}>
            Exit
          </Button>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <h1 className="mr-2 text-2xl text-grape">My code</h1>
            {runButtons}
            {state.status === 'asking' ? (
              <span className="text-sm text-not-yet-ink">
                Your program is waiting for you to type.
              </span>
            ) : null}
            <SaveControl className="ml-auto" state={autosave.state} onSave={autosave.save} />
            <Button variant="secondary" onClick={startPresenting} disabled={!activeId}>
              Present
            </Button>
          </div>

          {autosave.state === 'failed' ? (
            <Notice tone="system-error">
              Your code isn’t saving. Check your connection, or sign in again.
            </Notice>
          ) : null}
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
        </>
      )}

      <div
        className={`min-h-0 flex-[2] overflow-hidden ring-1 ring-grape/25 ${
          presenting ? 'rounded-2xl' : 'rounded-b-lg rounded-tr-lg'
        }`}
      >
        {active.isPending && activeId ? (
          <div className="flex h-full items-center justify-center bg-night">
            <Spinner label="Opening your file" />
          </div>
        ) : (
          <CodeSurface
            onSave={autosave.save}
            key={activeId ?? 'none'}
            value={code}
            onChange={autosave.onChange}
            fontSize={presenting ? PRESENT_FONT_SIZE : 15}
            language={languageOf(active.data?.title)}
          />
        )}
      </div>
      <div className="min-h-0 flex-1">
        <Console
          segments={output}
          asking={state.status === 'asking'}
          onAnswer={answer}
          large={presenting}
        />
      </div>

      {files.error ? <Notice tone="system-error">{messageFor(files.error)}</Notice> : null}
      </div>
    </div>
  )
}
