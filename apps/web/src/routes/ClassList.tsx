/**
 * A teacher's classes.
 *
 * Every teacher at the centre sees every class, not just their own: they cover each
 * other's lessons, and a per-teacher filter would lock a covering teacher out of the
 * roster they are about to need. `class_teachers` records who leads what; it does not
 * gate visibility.
 */

import { useState } from 'react'
import { Link } from 'react-router'
import { Button } from '../components/Button'
import { Card, EmptyState, PageHeader } from '../components/Card'
import { TextInput } from '../components/Field'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { messageFor } from '../lib/errors'
import { useClasses, useCreateClass } from '../lib/queries'

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
      ) : null}
    </>
  )
}
