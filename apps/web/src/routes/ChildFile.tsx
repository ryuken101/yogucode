/**
 * A child's file, opened by a teacher from the Files app (16 Oct 2026) — in the Code
 * window, read-only.
 *
 * The teacher can run it to see what it does, but not change it: changing a child's work
 * goes through Live's Help, where the child's editor is locked while the teacher types and
 * the edit is recorded as the teacher's (`app/live/hub.py`). The file is read fresh each
 * time it opens, so it is what the child last saved.
 */

import { Link, useParams } from 'react-router'
import { Button } from '../components/Button'
import { Console } from '../components/Console'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { useDesk } from '../desktop/context'
import { CodeSurface } from '../editor/CodeSurface'
import { messageFor } from '../lib/errors'
import { isPythonFile, languageOf } from '../lib/fileType'
import { useChildDocument, useRoster } from '../lib/queries'
import { usePython } from '../runtime/usePython'

export function ChildFile() {
  const { studentId = '', documentId = '' } = useParams()
  const { classId } = useDesk()
  const file = useChildDocument(studentId, documentId)
  const roster = useRoster(classId ?? '', classId !== null)
  const child = roster.data?.find((s) => s.student_id === studentId)?.display_name ?? 'A student'
  const { state, output, run, stop, answer } = usePython()

  if (file.isPending) return <Spinner label="Opening the file" />
  if (file.error) return <Notice tone="system-error">{messageFor(file.error)}</Notice>
  if (state.status === 'unsupported') return <Notice tone="system-error">{state.reason}</Notice>

  const busy = state.status === 'running' || state.status === 'asking'
  const python = isPythonFile(file.data.title)

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <h1 className="mr-2 text-xl text-grape">
          {child} — <span className="font-mono">{file.data.title}</span>
        </h1>
        <Button
          variant="primary"
          onClick={() => run(file.data.content)}
          disabled={busy || state.status === 'loading' || !python}
        >
          {busy ? 'Running…' : 'Run'}
        </Button>
        <Button variant="secondary" onClick={stop} disabled={!busy}>
          Stop
        </Button>
        {state.status === 'loading' ? <Spinner label={state.detail} /> : null}
        <span className="flex-1" />
        <Link to={`/files/students/${studentId}`} className="text-sm text-grape-deep underline">
          Back to {child}’s files
        </Link>
      </div>
      <Notice tone="info">
        Watching — read only. To change it with them, use Help in{' '}
        {classId ? (
          <Link to={`/classes/${classId}/live`} className="underline">
            Live
          </Link>
        ) : (
          'Live'
        )}
        .
      </Notice>
      <div className="min-h-0 flex-[2] overflow-hidden rounded-lg ring-1 ring-grape/25">
        <CodeSurface
          key={file.data.id}
          value={file.data.content}
          onChange={() => {}}
          readOnly
          language={languageOf(file.data.title)}
        />
      </div>
      <div className="min-h-0 flex-1">
        <Console segments={output} asking={state.status === 'asking'} onAnswer={answer} />
      </div>
    </div>
  )
}
