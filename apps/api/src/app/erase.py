"""Deleting entirely — the one exception to archive-never-delete (Ken's decision, 11 Oct
2026).

Archiving stays the everyday action. **Delete entirely** exists for the cases archiving
cannot answer: a parent asking for their child's data to be erased, or a test class that
should leave no trace. Only the centre's owner can do it, and only after typing the name.

Both functions delete **children first, in foreign-key order**, inside the caller's
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

from app.models import (
    Assignment,
    AssignmentNote,
    Attempt,
    AuditLog,
    Class,
    ClassJoinCode,
    ClassTeacher,
    Enrolment,
    Event,
    Mark,
    Student,
    StudentCredential,
    StudentDocument,
    StudentFolder,
    StudentSession,
    Submission,
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
