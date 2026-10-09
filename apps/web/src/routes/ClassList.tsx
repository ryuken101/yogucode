/**
 * A teacher's classes.
 *
 * Every teacher at the centre sees every class, not just their own: they cover each
 * other's lessons, and a per-teacher filter would lock a covering teacher out of the
 * roster they are about to need. `class_teachers` records who teaches what (the Teachers
 * box on a class); it does not gate visibility. It does sort the list: the classes you
 * teach come first under "My classes", everyone else's under "Other classes".
 */

import { useState } from 'react'
import { Link } from 'react-router'
import { Button } from '../components/Button'
import { Card, EmptyState, PageHeader } from '../components/Card'
import { TextInput } from '../components/Field'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import type { Schemas } from '../lib/api'
import { messageFor } from '../lib/errors'
import {
  useArchiveClass,
  useClasses,
  useClassesWithArchived,
  useCreateClass,
} from '../lib/queries'

export function ClassList() {
  const { data: classes, isPending, error } = useClasses()
  const create = useCreateClass()
  const [name, setName] = useState('')
  const [termLabel, setTermLabel] = useState('')

  function submit(event: React.FormEvent) {
    event.preventDefault()
    create.mutate(
      { name: name.trim(), term_label: termLabel.trim() || null },
      { onSuccess: () => { setName(''); setTermLabel('') } },
    )
  }

  return (
    <>
      <PageHeader title="Classes" />

      <Card className="mb-6">
        <h2 className="mb-3 font-display font-semibold text-lg text-grape">New class</h2>
        <form onSubmit={submit} className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex-1">
            <TextInput
              label="Class name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Year 4-6 Python"
            />
          </div>
          <div className="flex-1">
            <TextInput
              label="Term (optional)"
              value={termLabel}
              onChange={(event) => setTermLabel(event.target.value)}
              placeholder="2026 T4"
            />
          </div>
          <Button type="submit" variant="primary" disabled={create.isPending || !name.trim()}>
            {create.isPending ? 'Creating…' : 'Create class'}
          </Button>
        </form>
        {create.error ? (
          <div className="mt-3">
            <Notice tone="not-yet">{messageFor(create.error)}</Notice>
          </div>
        ) : null}
      </Card>

      {isPending ? <Spinner label="Loading classes" /> : null}
      {error ? <Notice tone="system-error">{messageFor(error)}</Notice> : null}

      {classes && classes.length === 0 ? (
        <EmptyState title="No classes yet">
          Create one above. It gets a join code straight away.
        </EmptyState>
      ) : null}

      {classes && classes.length > 0 ? (
        <ClassGroups classes={classes} />
      ) : null}

      <RemovedClasses />
    </>
  )
}

function ClassRows({ classes }: { classes: Schemas['ClassOut'][] }) {
  return (
    <ul className="flex flex-col gap-2">
      {classes.map((klass) => (
        <li key={klass.id}>
          <Link
            to={`/classes/${klass.id}`}
            className="flex items-center justify-between rounded-2xl bg-surface px-5 py-4 ring-1 ring-line hover:ring-grape"
          >
            <span className="font-medium text-grape">{klass.name}</span>
            <span className="text-sm text-muted">{klass.term_label ?? ''}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/** Mine first, then the rest. A heading only appears when both groups have classes. */
function ClassGroups({ classes }: { classes: Schemas['ClassOut'][] }) {
  const mine = classes.filter((klass) => klass.is_mine)
  const others = classes.filter((klass) => !klass.is_mine)
  if (mine.length === 0 || others.length === 0) return <ClassRows classes={classes} />
  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="mb-2 text-lg text-grape">My classes</h2>
        <ClassRows classes={mine} />
      </section>
      <section>
        <h2 className="mb-2 text-lg text-grape">Other classes</h2>
        <ClassRows classes={others} />
      </section>
    </div>
  )
}

/** Classes that were removed, with Put back. Collapsed, and only fetched when opened. */
function RemovedClasses() {
  const [open, setOpen] = useState(false)
  const all = useClassesWithArchived(open)
  const restore = useArchiveClass()
  const removed = all.data?.filter((klass) => klass.status === 'archived') ?? []

  return (
    <div className="mt-6">
      <Button variant="quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? '▾ Hide removed classes' : '▸ Show removed classes'}
      </Button>
      {open ? (
        <div className="mt-2">
          {all.isPending ? <Spinner label="Loading removed classes" /> : null}
          {all.error ? <Notice tone="system-error">{messageFor(all.error)}</Notice> : null}
          {all.data && removed.length === 0 ? (
            <p className="px-2 text-sm text-muted">No classes have been removed.</p>
          ) : null}
          {removed.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {removed.map((klass) => (
                <li
                  key={klass.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-surface/60 px-5 py-3 ring-1 ring-line"
                >
                  <Link to={`/classes/${klass.id}`} className="text-muted hover:underline">
                    {klass.name}
                    {klass.term_label ? <span className="ml-2 text-sm">{klass.term_label}</span> : null}
                  </Link>
                  <Button
                    variant="secondary"
                    disabled={restore.isPending}
                    onClick={() => restore.mutate({ classId: klass.id, archive: false })}
                  >
                    Put back
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {restore.error ? (
            <div className="mt-2">
              <Notice tone="system-error">{messageFor(restore.error)}</Notice>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
