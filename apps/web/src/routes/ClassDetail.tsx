/**
 * One class: who is in it, how they get in, and their PINs — the Classes app's Students tab.
 * Its homework and quizzes are the Work app's (`ClassWork.tsx`, 16 Oct 2026).
 *
 * This is the screen a teacher actually works from, so the three things they do on a
 * lesson night are all reachable without scrolling past anything else: read out the join
 * code, add the children who turned up, and reissue a PIN for whoever forgot theirs.
 */

import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card, EmptyState, PageHeader } from '../components/Card'
import { Dialog } from '../components/Dialog'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { ApiError, messageFor } from '../lib/errors'
import {
  useClass,
  useCourse,
  useCourses,
  useSetClassCurriculum,
  useIssuePins,
  useArchiveClass,
  useDeleteClass,
  useDeleteStudent,
  useMe,
  useReinstateStudent,
  useRevokeSessions,
  useRoster,
  useRosterWithWithdrawn,
  useWithdrawStudent,
} from '../lib/queries'
import { Select } from '../components/Field'
import { BulkPasteDialog } from './BulkPasteDialog'
import { ClassTeachersCard } from './ClassTeachersCard'
import { RemoveDialog } from '../components/RemoveDialog'
import { ShowPin } from './ShowPin'
import { AddStudentDialog, ChangePinDialog, UsernameDialog } from './StudentAccountDialogs'
import type { SlipState } from './SlipSheet'

export function ClassDetail() {
  const { classId = '' } = useParams<{ classId: string }>()
  const navigate = useNavigate()
  const klass = useClass(classId)
  const roster = useRoster(classId)
  const issuePins = useIssuePins(classId)
  const revoke = useRevokeSessions()

  const [pasteOpen, setPasteOpen] = useState(false)
  const [confirmReissue, setConfirmReissue] = useState(false)
  const [kicked, setKicked] = useState<string | null>(null)
  const withdraw = useWithdrawStudent(classId)
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null)
  const archive = useArchiveClass()
  const deleteClass = useDeleteClass()
  const deleteStudent = useDeleteStudent(classId)
  const isOwner = useMe({ retry: false }).data?.role === 'owner'
  const [confirmRemoveClass, setConfirmRemoveClass] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [pinFor, setPinFor] = useState<{ id: string; name: string } | null>(null)
  const [usernameFor, setUsernameFor] = useState<{
    id: string
    name: string
    username: string
  } | null>(null)

  function goToSlips(slips: SlipState['slips']) {
    navigate(`/classes/${classId}/slips`, {
      state: {
        slips,
        className: klass.data?.name ?? '',
      } satisfies SlipState,
    })
  }

  if (klass.isPending) return <Spinner label="Loading class" />
  if (klass.error) return <Notice tone="system-error">{messageFor(klass.error)}</Notice>

  const withoutPins = roster.data?.filter((entry) => !entry.has_pin).length ?? 0

  const removed = klass.data.status === 'archived'

  return (
    <>
      {removed ? (
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <Notice tone="info">
            This class has been removed. Its students, work and marks are all kept.
          </Notice>
          <Button
            variant="primary"
            disabled={archive.isPending}
            onClick={() => archive.mutate({ classId, archive: false })}
          >
            Put back
          </Button>
        </div>
      ) : null}
      <PageHeader title={klass.data.name}>
        <Button variant="primary" onClick={() => navigate(`/classes/${classId}/live`)}>
          Live
        </Button>
        <Button variant="secondary" onClick={() => navigate(`/classes/${classId}/progress`)}>
          Progress
        </Button>
        <Button variant="secondary" onClick={() => setAddOpen(true)}>
          Add a student
        </Button>
        <Button variant="quiet" onClick={() => setPasteOpen(true)}>
          Paste a list
        </Button>
      </PageHeader>

      {/* Children sign in with their own username and PIN (Ken's decision, 11 Oct 2026):
          no class code any more. */}
      <Notice tone="info">
        Students go to <span className="font-mono">{window.location.host}</span> and sign in
        with the username and PIN on their slip.
      </Notice>
      <div className="mb-6" />

      <ClassTeachersCard classId={classId} />

      <CurriculumCard
        classId={classId}
        courseId={klass.data.course_id}
        lessonId={klass.data.current_lesson_id}
      />

      <Card className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display font-semibold text-lg text-grape">Logins</h2>
            <p className="text-sm text-muted">
              Each student signs in with their username and PIN. Print the slips when you set
              them; Show PIN looks one up later.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={issuePins.isPending || withoutPins === 0}
              onClick={() =>
                issuePins.mutate(false, {
                  onSuccess: (slips) =>
                    slips.length ? goToSlips(slips) : undefined,
                })
              }
            >
              {issuePins.isPending ? 'Issuing…' : 'Issue missing PINs'}
            </Button>
            <Button variant="quiet" onClick={() => setConfirmReissue(true)}>
              Reissue all
            </Button>
          </div>
        </div>
        {issuePins.isSuccess && issuePins.data.length === 0 ? (
          <div className="mt-3">
            <Notice tone="good">Everyone already has a PIN.</Notice>
          </div>
        ) : null}
        {issuePins.error ? (
          <div className="mt-3">
            <Notice tone="system-error">{messageFor(issuePins.error)}</Notice>
          </div>
        ) : null}
      </Card>

      <h2 className="mb-3 font-display font-semibold text-lg text-grape">Roster</h2>
      {roster.isPending ? <Spinner label="Loading roster" /> : null}
      {roster.error ? <Notice tone="system-error">{messageFor(roster.error)}</Notice> : null}

      {roster.data && roster.data.length === 0 ? (
        <EmptyState title="Nobody in this class yet">
          Use “Add students” to paste the whole list at once.
        </EmptyState>
      ) : null}

      {roster.data && roster.data.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {roster.data.map((entry) => (
            <li
              key={entry.student_id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-surface px-5 py-3 ring-1 ring-line"
            >
              <div className="flex flex-wrap items-baseline gap-x-3">
                <Link to={`/students/${entry.student_id}`} className="font-medium text-grape hover:text-grape-deep hover:underline">
                  {entry.display_name}
                </Link>
                <span className="font-mono text-sm text-muted">{entry.username}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {entry.student_status === 'archived' ? <Badge variant="muted">Archived</Badge> : null}
                {!entry.has_pin ? <Badge variant="not-yet">No PIN yet</Badge> : null}
                {entry.has_pin ? (
                  <ShowPin
                    studentId={entry.student_id}
                    name={entry.display_name}
                    viewable={entry.pin_viewable}
                  />
                ) : null}
                <Button
                  variant="quiet"
                  onClick={() =>
                    setUsernameFor({
                      id: entry.student_id,
                      name: entry.display_name,
                      username: entry.username,
                    })
                  }
                >
                  Username
                </Button>
                <Button
                  variant="quiet"
                  onClick={() => setPinFor({ id: entry.student_id, name: entry.display_name })}
                >
                  {entry.has_pin ? 'Change PIN' : 'Set PIN'}
                </Button>
                <Button
                  variant="quiet"
                  disabled={revoke.isPending}
                  onClick={() =>
                    revoke.mutate(entry.student_id, {
                      onSuccess: (result) =>
                        setKicked(
                          result.revoked
                            ? `${entry.display_name} has been signed out.`
                            : `${entry.display_name} was not signed in.`,
                        ),
                    })
                  }
                >
                  Sign out
                </Button>
                <Button
                  variant="quiet"
                  onClick={() => setRemoving({ id: entry.student_id, name: entry.display_name })}
                >
                  Remove from class
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {withdraw.error ? (
        <div className="mt-3">
          <Notice tone="system-error">{messageFor(withdraw.error)}</Notice>
        </div>
      ) : null}

      <RemovedStudents classId={classId} />

      {kicked ? (
        <div className="mt-4">
          <Notice tone="good">{kicked}</Notice>
        </div>
      ) : null}

      {!removed ? (
        <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6">
          <p className="text-sm text-muted">
            Finished with this class? Removing it keeps every student’s work, and you can put it
            back later.
          </p>
          <Button variant="quiet" onClick={() => setConfirmRemoveClass(true)}>
            Remove class
          </Button>
        </div>
      ) : null}
      {archive.error ? (
        <div className="mt-3">
          <Notice tone="system-error">{messageFor(archive.error)}</Notice>
        </div>
      ) : null}

      <RemoveDialog
        open={confirmRemoveClass}
        onClose={() => setConfirmRemoveClass(false)}
        title={`Remove ${klass.data.name}?`}
        name={klass.data.name}
        isOwner={isOwner}
        archiveLabel="Archive class"
        archiveText="Archive it: it disappears from your classes, its join code stops working, and anyone signed in to it is signed out. Every student’s work, homework and marks are kept, and you can put the class back from “Show removed classes”."
        onArchive={() =>
          archive.mutate(
            { classId, archive: true },
            {
              onSuccess: () => {
                setConfirmRemoveClass(false)
                navigate('/classes')
              },
            },
          )
        }
        deleteText="This deletes the class with all its homework, quizzes, handed-in work and marks. The students’ accounts and their own files stay."
        onDelete={(confirmName) =>
          deleteClass.mutate(
            { classId, confirmName },
            {
              onSuccess: () => {
                setConfirmRemoveClass(false)
                navigate('/classes')
              },
            },
          )
        }
        busy={archive.isPending || deleteClass.isPending}
        error={deleteClass.error ? messageFor(deleteClass.error) : null}
      />

      <BulkPasteDialog classId={classId} open={pasteOpen} onClose={() => setPasteOpen(false)} />

      <AddStudentDialog
        classId={classId}
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(slip) => {
          setAddOpen(false)
          goToSlips([slip])
        }}
      />
      <ChangePinDialog
        classId={classId}
        student={pinFor}
        onClose={() => setPinFor(null)}
        onChanged={(slip) => {
          setPinFor(null)
          goToSlips([slip])
        }}
      />
      <UsernameDialog
        key={usernameFor?.id ?? 'none'}
        classId={classId}
        student={usernameFor}
        onClose={() => setUsernameFor(null)}
      />

      <RemoveDialog
        key={removing?.id ?? 'none'}
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={removing ? `Remove ${removing.name} from this class?` : ''}
        name={removing?.name ?? ''}
        isOwner={isOwner}
        archiveLabel="Remove from class"
        archiveText="They’ll be signed out straight away and won’t be able to sign in to this class. Their saved work, homework and marks are kept, and you can put them back any time from “Show removed students”."
        onArchive={() => {
          if (!removing) return
          withdraw.mutate(removing.id, { onSuccess: () => setRemoving(null) })
        }}
        deleteText="This deletes their account and everything they made, in every class: their files, homework, quiz answers, marks and history."
        onDelete={(confirmName) => {
          if (!removing) return
          deleteStudent.mutate(
            { studentId: removing.id, confirmName },
            { onSuccess: () => setRemoving(null) },
          )
        }}
        busy={withdraw.isPending || deleteStudent.isPending}
        error={deleteStudent.error ? messageFor(deleteStudent.error) : null}
      />


      <Dialog
        open={confirmReissue}
        title="Reissue every PIN?"
        onClose={() => setConfirmReissue(false)}
        confirm={{
          label: 'Reissue all',
          onConfirm: () => {
            setConfirmReissue(false)
            issuePins.mutate(true, { onSuccess: (slips) => goToSlips(slips) })
          },
        }}
      >
        Every student in this class gets a new PIN and their old one stops working. Use
        this when the slips have gone missing.
      </Dialog>
    </>
  )
}

/**
 * Which course the class follows, and which lesson it is on today.
 *
 * "Today's lesson" is what decides which ladder a child sees when they open the class
 * (step 6), so it sits on the class page a teacher already has open at the start of a
 * lesson rather than somewhere in the curriculum editor.
 */
/**
 * Children taken out of this class, with Put back. Collapsed by default — the roster is
 * who is here now — and only fetched when opened.
 */
function RemovedStudents({ classId }: { classId: string }) {
  const [open, setOpen] = useState(false)
  const everyone = useRosterWithWithdrawn(classId, open)
  const reinstate = useReinstateStudent(classId)
  const removed = everyone.data?.filter((entry) => entry.status === 'withdrawn') ?? []

  return (
    <div className="mt-4">
      <Button variant="quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? '▾ Hide removed students' : '▸ Show removed students'}
      </Button>
      {open ? (
        <div className="mt-2">
          {everyone.isPending ? <Spinner label="Loading removed students" /> : null}
          {everyone.error ? (
            <Notice tone="system-error">{messageFor(everyone.error)}</Notice>
          ) : null}
          {everyone.data && removed.length === 0 ? (
            <p className="px-2 text-sm text-muted">Nobody has been removed from this class.</p>
          ) : null}
          {removed.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {removed.map((entry) => (
                <li
                  key={entry.student_id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-surface/60 px-5 py-3 ring-1 ring-line"
                >
                  <span className="text-muted">
                    {entry.display_name}
                    {entry.withdrawn_at ? (
                      <span className="ml-2 text-sm">
                        removed{' '}
                        {new Date(entry.withdrawn_at).toLocaleDateString(undefined, {
                          day: 'numeric',
                          month: 'short',
                        })}
                      </span>
                    ) : null}
                  </span>
                  <Button
                    variant="secondary"
                    disabled={reinstate.isPending}
                    onClick={() => reinstate.mutate(entry.student_id)}
                  >
                    Put back
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {reinstate.error ? (
            // A name clash (409) is the teacher's to fix by renaming; not a fault.
            <div className="mt-2">
              <Notice
                tone={
                  reinstate.error instanceof ApiError && reinstate.error.status === 409
                    ? 'not-yet'
                    : 'system-error'
                }
              >
                {messageFor(reinstate.error)}
              </Notice>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function CurriculumCard({
  classId,
  courseId,
  lessonId,
}: {
  classId: string
  courseId: string | null
  lessonId: string | null
}) {
  const courses = useCourses()
  const course = useCourse(courseId)
  const setCurriculum = useSetClassCurriculum(classId)

  return (
    <Card className="mb-6">
      <h2 className="mb-3 font-display font-semibold text-lg text-grape">Curriculum</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="Course"
          value={courseId ?? ''}
          disabled={setCurriculum.isPending}
          onChange={(event) =>
            setCurriculum.mutate({
              course_id: event.target.value || null,
              current_lesson_id: null,
            })
          }
        >
          <option value="">No course yet</option>
          {(courses.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </Select>
        <Select
          label="Today’s lesson"
          value={lessonId ?? ''}
          disabled={!courseId || setCurriculum.isPending}
          onChange={(event) =>
            setCurriculum.mutate({
              course_id: courseId,
              current_lesson_id: event.target.value || null,
            })
          }
        >
          <option value="">None</option>
          {(course.data?.units ?? []).map((unit) => (
            <optgroup key={unit.id} label={unit.title}>
              {unit.lessons.map((lesson) => (
                <option key={lesson.id} value={lesson.id}>
                  {lesson.title}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </div>
      {setCurriculum.error ? (
        <div className="mt-3">
          <Notice tone="not-yet">{messageFor(setCurriculum.error)}</Notice>
        </div>
      ) : null}
    </Card>
  )
}
