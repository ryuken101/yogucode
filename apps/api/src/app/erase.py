"""Deleting for good: the only place rows are hard-deleted.

Two ways in. **Delete entirely** (Ken's decision, 11 Oct 2026) erases a child or a class at
once: a parent asking for their child's data to be erased, or a test class that should
leave no trace. Only the centre's owner can do it, and only after typing the name. And
the **Trash** (Ken, 23 Oct 2026, `app/trash.py`) purges what has been in it for 30 days, or
sooner by hand, through the `erase_*` functions at the end of this file.

Every function deletes **children first, in foreign-key order**, inside the caller's
transaction — so either everything goes or nothing does. The order is the schema's
dependency graph (checked against `information_schema` when this was written):

    events ──► attempts, student_documents, students
    marks ──► submissions, attempts
    submissions ──► attempts
    attempts ──► assignments, students
    assignment_notes ──► assignments, students
    assignments ──► classes            (sets are shared lesson ladders: kept)
    enrolments, class_join_codes, class_teachers ──► classes
    enrolments, student_credentials, student_sessions, student_documents,
    student_folders ──► students   (student_documents ──► student_folders)

A table added later that points at `students` or `classes` must be added here, or the
final delete fails on its foreign key — loudly, which is the right way for it to fail.

`audit_log` is not deleted: it is the record of what was done, by whom. Rows about an
erased child keep their ids, but any `display_name` in their payload is blanked, so the
record survives without the child's name.
"""

import uuid
from dataclasses import dataclass

from pydantic import BaseModel, Field
from sqlalchemy import delete, select, update
from sqlmodel.ext.asyncio.session import AsyncSession

from app.live.hub import hub
from app.models import (
    Assignment,
    AssignmentNote,
    Attempt,
    AuditLog,
    Class,
    ClassJoinCode,
    ClassTeacher,
    Course,
    Enrolment,
    Event,
    Hint,
    Item,
    ItemConcept,
    Lesson,
    LessonConcept,
    Mark,
    ProblemSet,
    SetItem,
    Student,
    StudentCredential,
    StudentDocument,
    StudentFolder,
    StudentSession,
    Submission,
    TeacherDocument,
    TeacherFolder,
    TestCase,
    Unit,
)


class EraseIn(BaseModel):
    """Delete entirely: the name, typed out, as the confirmation (case and spaces ignored)."""

    confirm_name: str = Field(min_length=1, max_length=200)


def names_match(typed: str, actual: str) -> bool:
    return " ".join(typed.split()).casefold() == " ".join(actual.split()).casefold()


@dataclass
class Erased:
    """How many rows went, by table — returned for the audit entry."""

    counts: dict[str, int]


async def _delete(session: AsyncSession, counts: dict[str, int], name: str, statement) -> None:
    result = await session.exec(statement)
    counts[name] = counts.get(name, 0) + (result.rowcount or 0)


async def _erase_attempts(session: AsyncSession, counts: dict[str, int], attempt_ids) -> None:
    """Everything hanging off a set of attempts, then the attempts themselves."""
    await _delete(session, counts, "events", delete(Event).where(Event.attempt_id.in_(attempt_ids)))  # type: ignore[union-attr]
    await _delete(session, counts, "marks", delete(Mark).where(Mark.attempt_id.in_(attempt_ids)))  # type: ignore[attr-defined]
    await _delete(
        session,
        counts,
        "submissions",
        delete(Submission).where(Submission.attempt_id.in_(attempt_ids)),  # type: ignore[attr-defined]
    )
    await _delete(session, counts, "attempts", delete(Attempt).where(Attempt.id.in_(attempt_ids)))  # type: ignore[attr-defined]


async def erase_student(session: AsyncSession, student_id: uuid.UUID) -> Erased:
    """A child's account and everything they made or were given, everywhere."""
    # Their live connection goes first: nothing of theirs may stay on a teacher's screen.
    await hub.kick_student(student_id)
    counts: dict[str, int] = {}
    attempt_ids = select(Attempt.id).where(Attempt.student_id == student_id)
    # Events by student first: that covers their My files events too, which point at
    # student_documents rather than at an attempt.
    await _delete(session, counts, "events", delete(Event).where(Event.student_id == student_id))
    await _erase_attempts(session, counts, attempt_ids)
    for name, model in [
        ("assignment_notes", AssignmentNote),
        ("student_documents", StudentDocument),
        # After the files that sat in them; all at once, so parent links resolve together.
        ("student_folders", StudentFolder),
        ("student_sessions", StudentSession),
        ("student_credentials", StudentCredential),
        ("enrolments", Enrolment),
    ]:
        await _delete(session, counts, name, delete(model).where(model.student_id == student_id))  # type: ignore[attr-defined]
    await _delete(session, counts, "students", delete(Student).where(Student.id == student_id))

    # Keep the record of what was done, without the child's name: drop the key (`-`).
    await session.exec(
        update(AuditLog)
        .where(
            AuditLog.target_id == student_id,
            AuditLog.payload.has_key("display_name"),  # type: ignore[attr-defined]
        )
        .values(payload=AuditLog.payload.op("-")("display_name"))  # type: ignore[attr-defined]
    )
    return Erased(counts)


async def erase_class(session: AsyncSession, class_id: uuid.UUID) -> Erased:
    """A class and its work. Student accounts and their own files stay."""
    counts: dict[str, int] = {}
    assignment_ids = select(Assignment.id).where(Assignment.class_id == class_id)
    attempt_ids = select(Attempt.id).where(Attempt.assignment_id.in_(assignment_ids))  # type: ignore[attr-defined]
    await _erase_attempts(session, counts, attempt_ids)
    await _delete(
        session,
        counts,
        "assignment_notes",
        delete(AssignmentNote).where(AssignmentNote.assignment_id.in_(assignment_ids)),  # type: ignore[attr-defined]
    )
    await _delete(
        session, counts, "assignments", delete(Assignment).where(Assignment.class_id == class_id)
    )
    for name, model in [
        ("enrolments", Enrolment),
        ("class_join_codes", ClassJoinCode),
        ("class_teachers", ClassTeacher),
    ]:
        await _delete(session, counts, name, delete(model).where(model.class_id == class_id))  # type: ignore[attr-defined]
    await _delete(session, counts, "classes", delete(Class).where(Class.id == class_id))
    return Erased(counts)


# --- the Trash's purges (23 Oct 2026) --------------------------------------------------
# Called by `app.trash` when something leaves the Trash for good: by hand, or after 30 days.


async def erase_assignment(session: AsyncSession, assignment_id: uuid.UUID) -> Erased:
    """Homework or a quiz, and every child's attempts, marks and notes on it. Its problem set
    goes too when nothing else uses it — a lesson's ladder is never one of those."""
    counts: dict[str, int] = {}
    set_id = (
        await session.exec(select(Assignment.set_id).where(Assignment.id == assignment_id))  # type: ignore[call-overload]
    ).scalar_one_or_none()
    attempt_ids = select(Attempt.id).where(Attempt.assignment_id == assignment_id)
    await _erase_attempts(session, counts, attempt_ids)
    await _delete(
        session,
        counts,
        "assignment_notes",
        delete(AssignmentNote).where(AssignmentNote.assignment_id == assignment_id),  # type: ignore[arg-type]
    )
    await _delete(
        session, counts, "assignments", delete(Assignment).where(Assignment.id == assignment_id)
    )
    if set_id is not None:
        others = (
            await session.exec(select(Assignment.id).where(Assignment.set_id == set_id).limit(1))  # type: ignore[call-overload]
        ).first()
        ladder = (
            await session.exec(select(ProblemSet.lesson_id).where(ProblemSet.id == set_id))  # type: ignore[call-overload]
        ).scalar_one_or_none()
        if others is None and ladder is None:
            await _delete(
                session, counts, "set_items", delete(SetItem).where(SetItem.set_id == set_id)
            )  # type: ignore[arg-type]
            await _delete(
                session, counts, "sets", delete(ProblemSet).where(ProblemSet.id == set_id)
            )  # type: ignore[arg-type]
    return Erased(counts)


async def erase_item(session: AsyncSession, item_id: uuid.UUID) -> Erased:
    """A problem, its parts, checks, hints and concept tags, and any attempt at it. The Trash
    refuses a problem still in a ladder, homework or quiz, so by now those attempts belong
    only to work that has itself been deleted."""
    counts: dict[str, int] = {}
    ids = [item_id, *(await session.exec(select(Item.id).where(Item.parent_id == item_id))).all()]  # type: ignore[call-overload]
    ids = [i[0] if isinstance(i, tuple) else i for i in ids]
    attempt_ids = select(Attempt.id).where(Attempt.item_id.in_(ids))  # type: ignore[attr-defined]
    await _erase_attempts(session, counts, attempt_ids)
    for name, model in [
        ("set_items", SetItem),
        ("test_cases", TestCase),
        ("hints", Hint),
        ("item_concepts", ItemConcept),
    ]:
        await _delete(session, counts, name, delete(model).where(model.item_id.in_(ids)))  # type: ignore[attr-defined]
    # A newer version keeps its history, minus the link to the one that is going.
    await session.exec(
        update(Item).where(Item.supersedes_id.in_(ids)).values(supersedes_id=None)  # type: ignore[union-attr]
    )
    await _delete(session, counts, "items", delete(Item).where(Item.id.in_(ids)))  # type: ignore[attr-defined]
    return Erased(counts)


async def erase_lessons(session: AsyncSession, lesson_ids: list[uuid.UUID]) -> Erased:
    """Lessons. A class taught from one forgets it as today's lesson; its ladder is kept, so
    children's classwork on it survives, just no longer attached to a lesson."""
    counts: dict[str, int] = {}
    if not lesson_ids:
        return Erased(counts)
    await session.exec(
        update(Class)
        .where(Class.current_lesson_id.in_(lesson_ids))  # type: ignore[union-attr]
        .values(current_lesson_id=None)
    )
    await session.exec(
        update(ProblemSet)
        .where(ProblemSet.lesson_id.in_(lesson_ids))  # type: ignore[union-attr]
        .values(lesson_id=None)
    )
    await _delete(
        session,
        counts,
        "lesson_concepts",
        delete(LessonConcept).where(LessonConcept.lesson_id.in_(lesson_ids)),  # type: ignore[attr-defined]
    )
    await _delete(session, counts, "lessons", delete(Lesson).where(Lesson.id.in_(lesson_ids)))  # type: ignore[attr-defined]
    return Erased(counts)


async def erase_units(session: AsyncSession, unit_ids: list[uuid.UUID]) -> Erased:
    counts: dict[str, int] = {}
    if not unit_ids:
        return Erased(counts)
    lessons = (await session.exec(select(Lesson.id).where(Lesson.unit_id.in_(unit_ids)))).all()  # type: ignore[call-overload,attr-defined]
    counts.update(
        (
            await erase_lessons(session, [r[0] if isinstance(r, tuple) else r for r in lessons])
        ).counts
    )
    await _delete(session, counts, "units", delete(Unit).where(Unit.id.in_(unit_ids)))  # type: ignore[attr-defined]
    return Erased(counts)


async def erase_course(session: AsyncSession, course_id: uuid.UUID) -> Erased:
    counts: dict[str, int] = {}
    units = (await session.exec(select(Unit.id).where(Unit.course_id == course_id))).all()  # type: ignore[call-overload]
    counts.update(
        (await erase_units(session, [r[0] if isinstance(r, tuple) else r for r in units])).counts
    )
    await session.exec(update(Class).where(Class.course_id == course_id).values(course_id=None))  # type: ignore[arg-type]
    await _delete(session, counts, "courses", delete(Course).where(Course.id == course_id))  # type: ignore[arg-type]
    return Erased(counts)


async def erase_student_files(
    session: AsyncSession, document_ids: list[uuid.UUID], folder_ids: list[uuid.UUID]
) -> Erased:
    """A child's files (with their editing history) and folders. A problem saved to one of
    the files keeps its attempt, just no longer linked to a file."""
    counts: dict[str, int] = {}
    if document_ids:
        await _delete(
            session,
            counts,
            "events",
            delete(Event).where(Event.document_id.in_(document_ids)),  # type: ignore[union-attr]
        )
        await session.exec(
            update(Attempt).where(Attempt.document_id.in_(document_ids)).values(document_id=None)  # type: ignore[union-attr]
        )
        await _delete(
            session,
            counts,
            "student_documents",
            delete(StudentDocument).where(StudentDocument.id.in_(document_ids)),  # type: ignore[attr-defined]
        )
    if folder_ids:
        # All at once, so parent links resolve together.
        await _delete(
            session,
            counts,
            "student_folders",
            delete(StudentFolder).where(StudentFolder.id.in_(folder_ids)),  # type: ignore[attr-defined]
        )
    return Erased(counts)


async def erase_teacher_files(
    session: AsyncSession, document_ids: list[uuid.UUID], folder_ids: list[uuid.UUID]
) -> Erased:
    counts: dict[str, int] = {}
    if document_ids:
        await _delete(
            session,
            counts,
            "teacher_documents",
            delete(TeacherDocument).where(TeacherDocument.id.in_(document_ids)),  # type: ignore[attr-defined]
        )
    if folder_ids:
        await _delete(
            session,
            counts,
            "teacher_folders",
            delete(TeacherFolder).where(TeacherFolder.id.in_(folder_ids)),  # type: ignore[attr-defined]
        )
    return Erased(counts)
