/**
 * The curriculum: courses, their units, and the lessons in each unit.
 *
 * This is Magikid's scope and sequence as data (spec §3.7). A lesson's concepts are the
 * ones it *introduces*, which is what later gives a lesson's problem ladder its "today's
 * concept" and lets mastery be read in lessons rather than in abstract tags.
 *
 * Edited one row at a time, read whole: the page shows the full outline of one course,
 * and every edit invalidates that course.
 */

import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card, EmptyState, PageHeader } from '../components/Card'
import { Dialog } from '../components/Dialog'
import { Select, TextInput } from '../components/Field'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { api, type Schemas } from '../lib/api'
import { LadderDialog } from '../problems/LadderDialog'
import { messageFor } from '../lib/errors'
import {
  keys,
  useConcepts,
  useCourse,
  useCourseEdit,
  useCourses,
  useCreateCourse,
} from '../lib/queries'

/** A one-field form that clears itself on success — "add a unit", "add a lesson". */
function AddRow({
  label,
  onAdd,
  pending,
}: {
  label: string
  onAdd: (title: string) => Promise<unknown>
  pending: boolean
}) {
  const [title, setTitle] = useState('')
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!title.trim()) return
        void onAdd(title.trim()).then(() => setTitle(''))
      }}
    >
      <div className="flex-1">
        <TextInput label={label} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <Button type="submit" variant="secondary" disabled={pending || !title.trim()}>
        Add
      </Button>
    </form>
  )
}

interface Renaming {
  kind: 'unit' | 'lesson' | 'course'
  id: string
  title: string
}

export function Curriculum() {
  const courses = useCourses()
  const createCourse = useCreateCourse()
  const [chosen, setChosen] = useState<string | null>(null)
  const courseId = chosen ?? courses.data?.[0]?.id ?? null
  const course = useCourse(courseId)
  const concepts = useConcepts()

  const [renaming, setRenaming] = useState<Renaming | null>(null)
  const [tagging, setTagging] = useState<Schemas['LessonOut'] | null>(null)
  const [tagged, setTagged] = useState<string[]>([])
  const [laddering, setLaddering] = useState<Schemas['LessonOut'] | null>(null)

  const id = courseId ?? ''
  const addUnit = useCourseEdit(id, (title: string) => api.createUnit(id, title))
  const addLesson = useCourseEdit(id, (input: { unitId: string; title: string }) =>
    api.createLesson(input.unitId, input.title),
  )
  const client = useQueryClient()
  const rename = useCourseEdit(id, async (input: Renaming) => {
    if (input.kind === 'unit') return api.updateUnit(input.id, { title: input.title })
    if (input.kind === 'lesson') return api.updateLesson(input.id, { title: input.title })
    // A course's title is also in the course list, which the outline's key does not cover.
    const renamed = await api.renameCourse(input.id, input.title)
    await client.invalidateQueries({ queryKey: keys.courses })
    return renamed
  })
  const archiveUnit = useCourseEdit(id, (unitId: string) => api.archiveUnit(unitId))
  const archiveLesson = useCourseEdit(id, (lessonId: string) => api.archiveLesson(lessonId))
  const setConcepts = useCourseEdit(id, (input: { lessonId: string; conceptIds: string[] }) =>
    api.setLessonConcepts(input.lessonId, input.conceptIds),
  )

  const labels = new Map((concepts.data ?? []).map((c) => [c.id, c.label]))
  const error =
    createCourse.error ??
    addUnit.error ??
    addLesson.error ??
    rename.error ??
    archiveUnit.error ??
    archiveLesson.error ??
    setConcepts.error

  if (courses.isPending) return <Spinner label="Loading courses" />
  if (courses.error) return <Notice tone="system-error">{messageFor(courses.error)}</Notice>

  return (
    <>
      <PageHeader title="Curriculum" />

      {error ? (
        <div className="mb-4">
          <Notice tone="not-yet">{messageFor(error)}</Notice>
        </div>
      ) : null}

      <Card className="mb-6">
        <div className="grid items-end gap-4 sm:grid-cols-2">
          {courses.data.length > 0 ? (
            <Select label="Course" value={courseId ?? ''} onChange={(e) => setChosen(e.target.value)}>
              {courses.data.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </Select>
          ) : (
            <p className="text-sm text-ink-soft">No courses yet. Start with the one you teach.</p>
          )}
          <AddRow
            label="New course"
            pending={createCourse.isPending}
            onAdd={(title) =>
              createCourse.mutateAsync(title).then((created) => setChosen(created.id))
            }
          />
        </div>
      </Card>

      {course.data ? (
        <>
          <div className="mb-4 flex items-center gap-2">
            <h2 className="font-serif text-xl text-ink">{course.data.title}</h2>
            <Button
              variant="quiet"
              onClick={() =>
                setRenaming({ kind: 'course', id: course.data.id, title: course.data.title })
              }
            >
              Rename
            </Button>
          </div>

          {course.data.units.length === 0 ? (
            <EmptyState title="No units yet">
              Add the course’s units in order — “Variables”, “Loops”, “Lists”.
            </EmptyState>
          ) : null}

          {course.data.units.map((unit) => (
            <Card key={unit.id} className="mb-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-serif text-lg text-ink">{unit.title}</h3>
                <div className="flex gap-1">
                  <Button
                    variant="quiet"
                    onClick={() => setRenaming({ kind: 'unit', id: unit.id, title: unit.title })}
                  >
                    Rename
                  </Button>
                  <Button variant="quiet" onClick={() => archiveUnit.mutate(unit.id)}>
                    Archive
                  </Button>
                </div>
              </div>

              <ol className="mb-3 flex flex-col gap-2">
                {unit.lessons.map((lesson, index) => (
                  <li
                    key={lesson.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg bg-cream/60 px-3 py-2 ring-1 ring-ink/10"
                  >
                    <span className="w-6 text-sm text-ink-soft">{index + 1}.</span>
                    <span className="font-medium text-ink">{lesson.title}</span>
                    <span className="flex flex-wrap gap-1">
                      {lesson.concept_ids.map((conceptId) => (
                        <Badge key={conceptId} variant="active">
                          {labels.get(conceptId) ?? '…'}
                        </Badge>
                      ))}
                    </span>
                    <span className="ml-auto flex gap-1">
                      <Button variant="secondary" onClick={() => setLaddering(lesson)}>
                        Ladder
                      </Button>
                      <Button
                        variant="quiet"
                        onClick={() => {
                          setTagging(lesson)
                          setTagged(lesson.concept_ids)
                        }}
                      >
                        Concepts
                      </Button>
                      <Button
                        variant="quiet"
                        onClick={() =>
                          setRenaming({ kind: 'lesson', id: lesson.id, title: lesson.title })
                        }
                      >
                        Rename
                      </Button>
                      <Button variant="quiet" onClick={() => archiveLesson.mutate(lesson.id)}>
                        Archive
                      </Button>
                    </span>
                  </li>
                ))}
              </ol>

              <AddRow
                label="New lesson"
                pending={addLesson.isPending}
                onAdd={(title) => addLesson.mutateAsync({ unitId: unit.id, title })}
              />
            </Card>
          ))}

          <Card>
            <AddRow
              label="New unit"
              pending={addUnit.isPending}
              onAdd={(title) => addUnit.mutateAsync(title)}
            />
          </Card>
        </>
      ) : null}
      {course.isPending && courseId ? <Spinner label="Loading course" /> : null}

      <LadderDialog
        key={laddering?.id ?? 'closed'}
        lesson={laddering}
        onClose={() => setLaddering(null)}
      />

      <Dialog
        open={renaming !== null}
        title="Rename"
        onClose={() => setRenaming(null)}
        confirm={{
          label: 'Save',
          disabled: !renaming?.title.trim(),
          onConfirm: () => {
            if (renaming) rename.mutate({ ...renaming, title: renaming.title.trim() })
            setRenaming(null)
          },
        }}
      >
        {renaming ? (
          <TextInput
            label="Title"
            value={renaming.title}
            maxLength={120}
            onChange={(e) => setRenaming({ ...renaming, title: e.target.value })}
          />
        ) : null}
      </Dialog>

      <Dialog
        open={tagging !== null}
        title={tagging ? `What “${tagging.title}” introduces` : ''}
        onClose={() => setTagging(null)}
        confirm={{
          label: 'Save',
          onConfirm: () => {
            if (tagging) setConcepts.mutate({ lessonId: tagging.id, conceptIds: tagged })
            setTagging(null)
          },
        }}
      >
        <div className="flex flex-wrap gap-1.5">
          {(concepts.data ?? []).map((concept) => {
            const on = tagged.includes(concept.id)
            return (
              <button
                key={concept.id}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setTagged(on ? tagged.filter((x) => x !== concept.id) : [...tagged, concept.id])
                }
                className={`rounded-full px-2.5 py-1 text-xs ring-1 ${
                  on ? 'bg-sky-pale ring-sky' : 'bg-paper ring-ink/15'
                }`}
              >
                {concept.label}
              </button>
            )
          })}
        </div>
      </Dialog>
    </>
  )
}
