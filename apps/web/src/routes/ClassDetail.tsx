/**
 * One class: who is in it, how they get in, and their PINs.
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
import { api } from '../lib/api'
import { formatDue } from '../lib/dates'
import { ApiError, messageFor } from '../lib/errors'
import {
  useClass,
  useClassHomework,
  useClassQuizzes,
  useQuizMutation,
  useCourse,
  useHomeworkMutation,
  useCourses,
  useSetClassCurriculum,
  useIssuePins,
  useResetPin,
  useArchiveClass,
  useReinstateStudent,
  useRevokeSessions,
  useRoster,
  useRosterWithWithdrawn,
  useWithdrawStudent,
  useRotateJoinCode,
} from '../lib/queries'
import { Select } from '../components/Field'
import { BulkPasteDialog } from './BulkPasteDialog'
import { ClassTeachersCard } from './ClassTeachersCard'
import type { SlipState } from './SlipSheet'

export function ClassDetail() {
  const { classId = '' } = useParams<{ classId: string }>()
  const navigate = useNavigate()
  const klass = useClass(classId)
  const roster = useRoster(classId)
  const rotate = useRotateJoinCode(classId)
  const issuePins = useIssuePins(classId)
  const resetPin = useResetPin(classId)
  const revoke = useRevokeSessions()

  const [pasteOpen, setPasteOpen] = useState(false)
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [confirmReissue, setConfirmReissue] = useState(false)
  const [kicked, setKicked] = useState<string | null>(null)
  const withdraw = useWithdrawStudent(classId)
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null)
  const archive = useArchiveClass()
  const [confirmRemoveClass, setConfirmRemoveClass] = useState(false)

  function goToSlips(slips: SlipState['slips']) {
    navigate(`/classes/${classId}/slips`, {
      state: {
        slips,
        className: klass.data?.name ?? '',
        joinCode: klass.data?.join_code ?? null,
      } satisfies SlipState,
    })
  }

  if (klass.isPending) return <Spinner label="Loading class" />
  if (klass.error) return <Notice tone="system-error">{messageFor(klass.error)}</Notice>

  const withoutPins = roster.data?.length ?? 0

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
        <Button variant="secondary" onClick={() => setPasteOpen(true)}>
          Add students
        </Button>
      </PageHeader>

      <Card className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium text-muted">Join code</h2>
            {klass.data.join_code ? (
<>
              <p className="font-mono text-3xl tracking-[0.35em] text-grape">
                {klass.data.join_code}
              </p>
              <p className="mt-1 text-sm text-muted">
                Students go to <span className="font-mono text-grape">{window.location.host}</span>{' '}
                and type this code.
              </p>
              </>
            ) : (
              <p className="text-sm text-muted">
                This class has no code yet. Create one to let students join.
              </p>
            )}
          </div>
          <Button
            variant="secondary"
            onClick={() => setConfirmRotate(true)}
            disabled={rotate.isPending}
          >
            {klass.data.join_code ? 'New code' : 'Create code'}
          </Button>
        </div>
        {rotate.error ? (
          <div className="mt-3">
            <Notice tone="system-error">{messageFor(rotate.error)}</Notice>
          </div>
        ) : null}
      </Card>

      <ClassTeachersCard classId={classId} />

      <CurriculumCard
        classId={classId}
        courseId={klass.data.course_id}
        lessonId={klass.data.current_lesson_id}
      />

      <HomeworkCard classId={classId} />

      <QuizzesCard classId={classId} />

      <Card className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display font-semibold text-lg text-grape">PINs</h2>
            <p className="text-sm text-muted">
              Each student needs one to sign in. You’ll see them once, to print.
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
              <Link to={`/students/${entry.student_id}`} className="font-medium text-grape hover:text-grape-deep hover:underline">
                {entry.display_name}
              </Link>
              <div className="flex items-center gap-2">
                {entry.student_status === 'archived' ? <Badge variant="muted">Archived</Badge> : null}
                <Button
                  variant="quiet"
                  disabled={resetPin.isPending}
                  onClick={() =>
                    resetPin.mutate(entry.student_id, {
                      onSuccess: (slip) => goToSlips([slip]),
                    })
                  }
                >
                  Reset PIN
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

      <Dialog
        open={confirmRemoveClass}
        title={`Remove ${klass.data.name}?`}
        onClose={() => setConfirmRemoveClass(false)}
        confirm={{
          label: 'Remove class',
          disabled: archive.isPending,
          onConfirm: () =>
            archive.mutate(
              { classId, archive: true },
              {
                onSuccess: () => {
                  setConfirmRemoveClass(false)
                  navigate('/classes')
                },
              },
            ),
        }}
      >
        It disappears from your classes, its join code stops working, and anyone signed in to
        it is signed out. Every student’s work, homework and marks are kept, and you can put
        the class back from “Show removed classes”.
      </Dialog>

      <BulkPasteDialog classId={classId} open={pasteOpen} onClose={() => setPasteOpen(false)} />

      <Dialog
        open={removing !== null}
        title={removing ? `Remove ${removing.name} from this class?` : ''}
        onClose={() => setRemoving(null)}
        confirm={{
          label: 'Remove from class',
          disabled: withdraw.isPending,
          onConfirm: () => {
            if (!removing) return
            withdraw.mutate(removing.id, { onSuccess: () => setRemoving(null) })
          },
        }}
      >
        They’ll be signed out straight away and won’t be able to sign in to this class. Their
        saved work, homework and marks are kept, and you can put them back any time from
        “Show removed students”.
      </Dialog>

      <Dialog
        open={confirmRotate}
        title="Give this class a new code?"
        onClose={() => setConfirmRotate(false)}
        confirm={{
          label: 'New code',
          onConfirm: () => {
            rotate.mutate()
            setConfirmRotate(false)
          },
        }}
      >
        The current code stops working straight away, so anyone part-way through joining
        will need the new one.
      </Dialog>

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

/**
 * The class's homework: what is set, when it is due, how many have handed it in and been
 * marked. One line each, with the next thing to do with it — set a draft, mark a set one.
 */
function HomeworkCard({ classId }: { classId: string }) {
  const navigate = useNavigate()
  const homework = useClassHomework(classId)
  const close = useHomeworkMutation(classId, (id: string) => api.closeHomework(id))
  const reopen = useHomeworkMutation(classId, (id: string) => api.reopenHomework(id))

  return (
    <Card className="mb-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display font-semibold text-lg text-grape">Homework</h2>
        <Button variant="secondary" onClick={() => navigate(`/classes/${classId}/homework/new`)}>
          New homework
        </Button>
      </div>
      {homework.isPending ? <Spinner label="Loading homework" /> : null}
      {homework.data && homework.data.length === 0 ? (
        <p className="text-sm text-muted">None yet.</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {(homework.data ?? []).map((hw) => (
          <li
            key={hw.id}
            className="flex flex-wrap items-center gap-3 rounded-lg bg-cream/60 px-4 py-2.5 ring-1 ring-line"
          >
            <span className="font-medium text-grape">{hw.title}</span>
            {hw.status === 'draft' ? <Badge variant="active">Draft</Badge> : null}
            {hw.status === 'closed' ? <Badge variant="muted">Closed</Badge> : null}
            <span className="text-sm text-muted">due {formatDue(hw.due_at)}</span>
            {hw.status !== 'draft' ? (
              <span className="text-sm text-muted">
                {hw.handed_in}/{hw.students} handed in · {hw.marked} marked
                {hw.returned ? ` · ${hw.returned} given back` : ''}
              </span>
            ) : null}
            <span className="ml-auto flex gap-1">
              <Button variant="quiet" onClick={() => navigate(`/classes/${classId}/homework/${hw.id}`)}>
                {hw.status === 'draft' ? 'Edit' : 'Details'}
              </Button>
              {hw.status !== 'draft' ? (
                <Button variant="primary" onClick={() => navigate(`/assignments/${hw.id}/mark`)}>
                  Mark
                </Button>
              ) : null}
              {hw.status === 'open' ? (
                <Button variant="quiet" onClick={() => close.mutate(hw.id)}>
                  Close
                </Button>
              ) : null}
              {hw.status === 'closed' ? (
                <Button variant="quiet" onClick={() => reopen.mutate(hw.id)}>
                  Reopen
                </Button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {homework.error ? <Notice tone="system-error">{messageFor(homework.error)}</Notice> : null}
    </Card>
  )
}

/**
 * The class's quizzes. A draft is started from here or from its own page; starting one
 * switches every child to it and opens the live view, where it is watched and stopped.
 */
function QuizzesCard({ classId }: { classId: string }) {
  const navigate = useNavigate()
  const quizzes = useClassQuizzes(classId)
  const start = useQuizMutation(classId, (id: string) => api.startQuiz(id))
  const running = (quizzes.data ?? []).some((q) => q.running)

  return (
    <Card className="mb-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display font-semibold text-lg text-grape">Quizzes</h2>
        <Button variant="secondary" onClick={() => navigate(`/classes/${classId}/quizzes/new`)}>
          New quiz
        </Button>
      </div>
      {quizzes.data && quizzes.data.length === 0 ? <p className="text-sm text-muted">None yet.</p> : null}
      <ul className="flex flex-col gap-2">
        {(quizzes.data ?? []).map((quiz) => (
          <li
            key={quiz.id}
            className="flex flex-wrap items-center gap-3 rounded-lg bg-cream/60 px-4 py-2.5 ring-1 ring-line"
          >
            <span className="font-medium text-grape">{quiz.title}</span>
            <span className="text-sm text-muted">
              {quiz.questions.length} question{quiz.questions.length === 1 ? '' : 's'} · {quiz.duration_minutes} min
            </span>
            {quiz.status === 'draft' ? <Badge variant="active">Draft</Badge> : null}
            {quiz.running ? <Badge variant="good">Running</Badge> : null}
            {quiz.status === 'closed' ? <Badge variant="muted">Finished</Badge> : null}
            <span className="ml-auto flex gap-1">
              <Button variant="quiet" onClick={() => navigate(`/classes/${classId}/quizzes/${quiz.id}`)}>
                {quiz.status === 'draft' ? 'Edit' : 'Details'}
              </Button>
              {quiz.status === 'draft' ? (
                <Button
                  variant="primary"
                  disabled={running || start.isPending || quiz.questions.length === 0}
                  onClick={() =>
                    start.mutate(quiz.id, { onSuccess: () => navigate(`/classes/${classId}/live`) })
                  }
                >
                  Start
                </Button>
              ) : null}
              {quiz.running ? (
                <Button variant="primary" onClick={() => navigate(`/classes/${classId}/live`)}>
                  Watch
                </Button>
              ) : null}
              {quiz.status === 'closed' ? (
                <Button variant="primary" onClick={() => navigate(`/assignments/${quiz.id}/mark`)}>
                  Mark
                </Button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {start.error ? <Notice tone="not-yet">{messageFor(start.error)}</Notice> : null}
    </Card>
  )
}
