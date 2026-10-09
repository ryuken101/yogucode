/**
 * Who teaches this class: Lead and Assistant teachers (Ken's decision, 10 Oct 2026).
 *
 * Organisation, not permission. Every teacher at the centre can already open every class
 * — covering a colleague's lesson must never need someone to add you first. What this box
 * changes is who is listed here and whose "My classes" the class appears under. Any
 * teacher may edit it; the server keeps at least one Lead and audits every change.
 */

import { useState } from 'react'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { Select } from '../components/Field'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import type { Schemas } from '../lib/api'
import { api } from '../lib/api'
import { ApiError, messageFor } from '../lib/errors'
import {
  useClassTeacherCandidates,
  useClassTeacherMutation,
  useClassTeachers,
} from '../lib/queries'

type Role = Schemas['ClassTeacherRole']

const ROLE_LABEL: Record<Role, string> = { lead: 'Lead', assistant: 'Assistant' }

export function ClassTeachersCard({ classId }: { classId: string }) {
  const teachers = useClassTeachers(classId)
  const candidates = useClassTeacherCandidates(classId)
  const setRole = useClassTeacherMutation(classId, ({ userId, role }: { userId: string; role: Role }) =>
    api.setClassTeacher(classId, userId, role),
  )
  const remove = useClassTeacherMutation(classId, (userId: string) =>
    api.removeClassTeacher(classId, userId),
  )
  const [adding, setAdding] = useState('')
  const [addRole, setAddRole] = useState<Role>('assistant')

  const failure = setRole.error ?? remove.error
  // "Every class needs a Lead" (409) is a rule the teacher can satisfy, not a fault.
  const failureTone =
    failure instanceof ApiError && failure.status === 409 ? 'not-yet' : 'system-error'

  return (
    <Card className="mb-6">
      <h2 className="text-lg text-grape">Teachers</h2>
      <p className="mb-3 text-sm text-muted">
        Who teaches this class. Any teacher at the centre can still open it.
      </p>

      {teachers.isPending ? <Spinner label="Loading teachers" /> : null}
      {teachers.error ? <Notice tone="system-error">{messageFor(teachers.error)}</Notice> : null}

      {teachers.data ? (
        <ul className="divide-y divide-line">
          {teachers.data.map((teacher) => (
            <li key={teacher.user_id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="font-medium text-grape">
                {teacher.display_name}
                {teacher.is_you ? <span className="ml-1 text-sm text-muted">(you)</span> : null}
              </span>
              <Badge variant={teacher.role === 'lead' ? 'active' : 'muted'}>
                {ROLE_LABEL[teacher.role]}
              </Badge>
              <div className="ml-auto flex items-center gap-2">
                <label className="sr-only" htmlFor={`role-${teacher.user_id}`}>
                  Role for {teacher.display_name}
                </label>
                <select
                  id={`role-${teacher.user_id}`}
                  value={teacher.role}
                  disabled={setRole.isPending}
                  onChange={(event) =>
                    setRole.mutate({ userId: teacher.user_id, role: event.target.value as Role })
                  }
                  className="rounded-lg bg-surface px-2 py-1 text-sm text-grape ring-1 ring-grape/20"
                >
                  <option value="lead">Lead</option>
                  <option value="assistant">Assistant</option>
                </select>
                <Button
                  variant="quiet"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(teacher.user_id)}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
          {teachers.data.length === 0 ? (
            <li className="py-2 text-sm text-muted">No teachers listed yet.</li>
          ) : null}
        </ul>
      ) : null}

      {failure ? (
        <div className="mt-3">
          <Notice tone={failureTone}>{messageFor(failure)}</Notice>
        </div>
      ) : null}

      {candidates.data && candidates.data.length > 0 ? (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (!adding) return
            setRole.mutate(
              { userId: adding, role: addRole },
              { onSuccess: () => setAdding('') },
            )
          }}
        >
          <div className="min-w-56 flex-1">
            <Select
              label="Add a teacher"
              value={adding}
              onChange={(event) => setAdding(event.target.value)}
            >
              <option value="">Choose a teacher…</option>
              {candidates.data.map((candidate) => (
                <option key={candidate.user_id} value={candidate.user_id}>
                  {candidate.display_name} ({candidate.email})
                </option>
              ))}
            </Select>
          </div>
          <div className="w-40">
            <Select
              label="As"
              value={addRole}
              onChange={(event) => setAddRole(event.target.value as Role)}
            >
              <option value="assistant">Assistant</option>
              <option value="lead">Lead</option>
            </Select>
          </div>
          <Button type="submit" variant="secondary" disabled={!adding || setRole.isPending}>
            Add
          </Button>
        </form>
      ) : null}
      {candidates.data && candidates.data.length === 0 && teachers.data ? (
        <p className="mt-3 text-sm text-muted">
          Every teacher at the centre is already on this class.
        </p>
      ) : null}
    </Card>
  )
}
