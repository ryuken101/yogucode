/**
 * The Save window for a lesson or homework problem (Ken's decision, 17 Oct 2026).
 *
 * Like Save in any program: choose a folder in your Files and a name, then Save. The work
 * is then kept in that file as well as in the problem — every save after this updates it —
 * so it is in their Files to find, and to open at home. Asked once per problem; after that
 * Save just saves.
 *
 * A name already used in that folder is not-yet, not an error, with the choice to use that
 * file instead (it is then overwritten with this work).
 *
 * **Put it away in Files…** (Ken, 18 Oct 2026) saves the same way, then opens Files beside
 * the problem with the new file selected, for a child who would rather drag it into a
 * folder than choose one from a list. Moving the file keeps it linked.
 */

import { Folder, FolderPlus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { TextInput } from '../components/Field'
import { Notice } from '../components/Notice'
import { api, type Schemas } from '../lib/api'
import { messageFor } from '../lib/errors'
import { pathOf } from '../lib/folderTree'
import { useDocuments, useFolderActions, useFolders } from '../lib/queries'

interface Props {
  open: boolean
  /** What to call the file at first: the problem's title, as a Python file. */
  suggestedName: string
  code: string
  onClose: () => void
  /** The file was made (or chosen); link the work to it. */
  onSaved: (document: { id: string }) => Promise<void>
  /** After saving, show the file in Files to be dragged where it belongs. */
  onPutAway?: (document: { id: string; folder_id?: string | null }) => void
}

export function SaveToFiles({ open, suggestedName, code, onClose, onSaved, onPutAway }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const folders = useFolders('me')
  const files = useDocuments()
  const folderActions = useFolderActions('me')
  const [folderId, setFolderId] = useState<string | null>(null)
  const [name, setName] = useState(suggestedName)
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (open && !node.open) {
      setName(suggestedName)
      setProblem(null)
      node.showModal()
    }
    if (!open && node.open) node.close()
  }, [open, suggestedName])

  const all = folders.data ?? []
  const choices = [{ id: null as string | null, label: 'My work' }].concat(
    all.map((f) => ({ id: f.id, label: `My work / ${pathOf(all, f.id)}` })).sort((a, b) => a.label.localeCompare(b.label)),
  )
  const clash = (files.data ?? []).find(
    (f) => (f.folder_id ?? null) === folderId && f.title.toLowerCase() === name.trim().toLowerCase(),
  )

  async function save(useExisting?: Schemas['DocumentSummaryOut'], putAway = false) {
    setBusy(true)
    setProblem(null)
    try {
      const document = useExisting ?? (await api.createDocument({ folder_id: folderId, title: name.trim(), content: code }))
      await onSaved(document)
      onClose()
      if (putAway) onPutAway?.(document)
    } catch (refused) {
      setProblem(messageFor(refused))
    } finally {
      setBusy(false)
    }
  }

  async function makeFolder() {
    const folderName = (newFolder ?? '').trim()
    if (!folderName) return setNewFolder(null)
    try {
      const made = await folderActions.create.mutateAsync({ name: folderName, parentId: folderId })
      setFolderId(made.id)
      setNewFolder(null)
    } catch (refused) {
      setProblem(messageFor(refused))
    }
  }

  return (
    <dialog
      ref={ref}
      aria-label="Save to my files"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-3xl bg-surface p-0 text-grape backdrop:bg-night/40"
    >
      {open ? (
        <form
          className="flex flex-col gap-4 p-5"
          onSubmit={(event) => {
            event.preventDefault()
            if (!clash && name.trim()) void save()
          }}
        >
          <div>
            <h2 className="font-display text-xl font-semibold text-grape">Save to my files</h2>
            <p className="mt-1 text-sm text-muted">
              Choose where to keep it, or put it away in Files and drag it into a folder there.
              After this, Save keeps that file up to date — find it in Files, at school or at
              home.
            </p>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-sm font-medium text-grape">Where</span>
              <Button variant="quiet" onClick={() => setNewFolder('')}>
                <FolderPlus size={15} aria-hidden="true" className="mr-1" /> New folder
              </Button>
            </div>
            <ul role="listbox" aria-label="Folder" className="max-h-48 overflow-auto rounded-xl bg-cream/60 p-1 ring-1 ring-line">
              {choices.map((choice) => (
                <li key={choice.id ?? 'top'}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={choice.id === folderId}
                    onClick={() => setFolderId(choice.id)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm ${
                      choice.id === folderId ? 'bg-grape text-surface' : 'text-grape hover:bg-grape-pale'
                    }`}
                  >
                    <Folder size={15} aria-hidden="true" className="shrink-0" />
                    <span className="truncate">{choice.label}</span>
                  </button>
                </li>
              ))}
            </ul>
            {newFolder !== null ? (
              <div className="mt-2 flex items-end gap-2">
                <div className="flex-1">
                  <TextInput
                    label="New folder name"
                    value={newFolder}
                    autoFocus
                    onChange={(event) => setNewFolder(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void makeFolder()
                      }
                    }}
                  />
                </div>
                <Button variant="secondary" onClick={() => void makeFolder()}>
                  Make it
                </Button>
              </div>
            ) : null}
          </div>

          <TextInput label="File name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />

          {clash ? (
            <Notice tone="not-yet">
              There’s already a file called {clash.title} here. Choose another name, or keep your
              work in that file instead.{' '}
              <button type="button" className="underline" onClick={() => void save(clash)}>
                Use {clash.title}
              </button>
            </Notice>
          ) : null}
          {problem ? <Notice tone="not-yet">{problem}</Notice> : null}

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="quiet" onClick={onClose}>
              Cancel
            </Button>
            {onPutAway ? (
              <Button
                variant="secondary"
                disabled={busy || !name.trim() || Boolean(clash)}
                onClick={() => void save(undefined, true)}
              >
                Put it away in Files…
              </Button>
            ) : null}
            <Button type="submit" variant="primary" disabled={busy || !name.trim() || Boolean(clash)}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      ) : null}
    </dialog>
  )
}
