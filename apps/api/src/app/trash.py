"""The Trash (Ken's decision, 23 Oct 2026, reversing "archive, never delete").

Delete puts a thing in the Trash. From there it can be restored, or deleted for good; after
`TRASH_DAYS` the purge job (`purge_expired`, started in `main.py`) deletes it anyway. Remove
(a class at the end of term, a withdrawn child) and Archive (a problem) are unchanged: they
are kept for as long as anyone wants them, and never purged.

**How a row is "in the Trash"** (`models.base.TrashMixin`): `deleted_at` is set and its
status is `archived`, with the old status kept in `status_before_delete` for Restore. Every
query that already shows only active rows therefore hides it; the getters and the few
"show archived too" lists also check `deleted_at` (`app.scoping`).

**Groups.** A folder goes with everything inside it, a unit with its lessons, a course with
its units and lessons. They share one `deleted_at`, which is how Restore and Purge find the
group again, and only the top of a group is listed.

**Who may do what:**

- any teacher may trash and restore the centre's classes, children, problems, curriculum,
  homework and quizzes, and their own files; a child, their own files;
- deleting for good: a class or a child, the owner only, with the name typed (as Delete
  entirely); anything else, the owner, whoever put it in the Trash, or whoever made it;
  a child, never.

Purging goes through `app.erase`, which is the only place rows are hard-deleted.
"""

import asyncio
import contextlib
import logging
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.audit import audit_entry
from app.auth.principal import Principal
from app.auth.student_session import revoke_live_sessions
from app.erase import (
    Erased,
    erase_assignment,
    erase_class,
    erase_course,
    erase_item,
    erase_lessons,
    erase_student,
    erase_student_files,
    erase_teacher_files,
    erase_units,
    names_match,
)
from app.folders import subtree
from app.models import (
    ActorType,
    Assignment,
    AssignmentMode,
    AuditLog,
    Class,
    ClassJoinCode,
    Course,
    DocumentStatus,
    Enrolment,
    EnrolmentStatus,
    Item,
    Lesson,
    ProblemSet,
    SetItem,
    SetStatus,
    Student,
    StudentDocument,
    StudentFolder,
    TeacherDocument,
    TeacherFolder,
    Unit,
    User,
    UserRole,
)
from app.models.base import utcnow
from app.quiz import is_running

log = logging.getLogger(__name__)

TRASH_DAYS = 30
ARCHIVED = "archived"

# What the API calls each kind. "file" and "folder" are the caller's own: a child's for a
# child, a teacher's for a teacher.
TEACHER_KINDS = ("class", "student", "problem", "course", "unit", "lesson", "homework")
FILE_KINDS = ("file", "folder")
NAMED_PURGE = ("class", "student")


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not in the Trash")


def _model(kind: str, principal: Principal) -> Any:
    if kind == "file":
        return StudentDocument if principal.is_student else TeacherDocument
    if kind == "folder":
        return StudentFolder if principal.is_student else TeacherFolder
    return {
        "class": Class,
        "student": Student,
        "problem": Item,
        "course": Course,
        "unit": Unit,
        "lesson": Lesson,
        "homework": Assignment,
    }[kind]


def name_of(kind: str, row: Any) -> str:
    if kind == "student":
        return row.display_name
    if kind in ("class", "course", "unit", "lesson", "folder"):
        return row.name if hasattr(row, "name") else row.title
    return row.title


def put_in(row: Any, by: uuid.UUID, when: datetime) -> None:
    if row.deleted_at is not None:
        return
    row.status_before_delete = str(row.status)
    row.status = ARCHIVED
    row.deleted_at = when
    row.deleted_by = by


def take_out(row: Any) -> None:
    row.status = row.status_before_delete or "active"
    row.status_before_delete = None
    row.deleted_at = None
    row.deleted_by = None


async def _row(session: AsyncSession, principal: Principal, kind: str, row_id: uuid.UUID) -> Any:
    """The row, if this caller may act on it at all; 404 otherwise, as for any other centre's."""
    allowed = FILE_KINDS if principal.is_student else TEACHER_KINDS + FILE_KINDS
    if kind not in allowed:
        raise _not_found()
    row = await session.get(_model(kind, principal), row_id)
    if row is None or row.centre_id != principal.centre_id:
        raise _not_found()
    if kind in FILE_KINDS:
        owner = row.student_id if principal.is_student else row.user_id
        if owner != principal.subject_id:
            raise _not_found()
    if kind == "homework" and row.mode == AssignmentMode.CLASSWORK:
        raise _not_found()  # a lesson's classwork goes with its lesson, not on its own
    if kind == "problem" and row.parent_id is not None:
        raise _not_found()  # a part goes with its problem
    return row


# --- putting things in -----------------------------------------------------------------


async def _problem_in_use(session: AsyncSession, item_id: uuid.UUID) -> str | None:
    """Where a problem is still used, by name, or None. A problem can't be trashed from under
    a lesson's ladder or a homework or quiz that is still there."""
    sets = (
        await session.exec(
            select(ProblemSet)
            .join(SetItem, col(SetItem.set_id) == ProblemSet.id)
            .where(SetItem.item_id == item_id)
        )
    ).all()
    for problem_set in sets:
        if problem_set.lesson_id is not None and problem_set.status == SetStatus.ACTIVE:
            lesson = await session.get(Lesson, problem_set.lesson_id)
            if lesson is not None and lesson.deleted_at is None:
                return f"the lesson “{lesson.title}”"
        used = (
            await session.exec(
                select(Assignment).where(
                    Assignment.set_id == problem_set.id,
                    col(Assignment.deleted_at).is_(None),
                    Assignment.mode != AssignmentMode.CLASSWORK,
                )
            )
        ).first()
        if used is not None:
            return f"“{used.title}”"
    return None


async def _sign_class_out(session: AsyncSession, klass: Class, now: datetime) -> None:
    """What Remove does to a class's doors: join codes revoked, children signed out."""
    await session.exec(
        update(ClassJoinCode)
        .where(
            ClassJoinCode.class_id == klass.id,  # type: ignore[arg-type]
            ClassJoinCode.revoked_at.is_(None),  # type: ignore[union-attr]
        )
        .values(revoked_at=now)
    )
    enrolled = (
        await session.exec(
            select(Enrolment.student_id).where(
                Enrolment.class_id == klass.id, Enrolment.status == EnrolmentStatus.ACTIVE
            )
        )
    ).all()
    for student_id in enrolled:
        await revoke_live_sessions(session, student_id, now)


async def _folder_group(
    session: AsyncSession, principal: Principal, folder: Any
) -> tuple[list, list]:
    """A folder's branch: (folders, files), every one of them, trashed or not."""
    folder_model = type(folder)
    document_model = StudentDocument if folder_model is StudentFolder else TeacherDocument
    owner_column = "student_id" if folder_model is StudentFolder else "user_id"
    folders = (
        await session.exec(
            select(folder_model).where(
                folder_model.centre_id == principal.centre_id,
                getattr(folder_model, owner_column) == principal.subject_id,
            )
        )
    ).all()
    ids = subtree(folders, folder.id)
    files = (
        await session.exec(
            select(document_model).where(
                col(document_model.folder_id).in_(ids),
                getattr(document_model, owner_column) == principal.subject_id,
            )
        )
    ).all()
    return [f for f in folders if f.id in ids], list(files)


async def trash(session: AsyncSession, principal: Principal, kind: str, row_id: uuid.UUID) -> Any:
    """Put something in the Trash. Commits."""
    row = await _row(session, principal, kind, row_id)
    if row.deleted_at is not None:
        return row
    now = utcnow()
    by = principal.subject_id

    if kind == "problem":
        where = await _problem_in_use(session, row.id)
        if where is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"It’s still used in {where}. Take it out of there first.",
            )
    if kind == "homework" and is_running(row, now):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="That quiz is running. Stop it first."
        )

    group: list[Any] = [row]
    if kind == "folder":
        folders, files = await _folder_group(session, principal, row)
        group = [*folders, *files]
    elif kind == "unit":
        group += (await session.exec(select(Lesson).where(Lesson.unit_id == row.id))).all()
    elif kind == "course":
        units = (await session.exec(select(Unit).where(Unit.course_id == row.id))).all()
        group += units
        if units:
            group += (
                await session.exec(
                    select(Lesson).where(col(Lesson.unit_id).in_([u.id for u in units]))
                )
            ).all()
    for member in group:
        # Anything already in the Trash on its own stays its own group.
        if member.deleted_at is None:
            put_in(member, by, now)
            session.add(member)

    lessons = [m.id for m in group if isinstance(m, Lesson)]
    if lessons:
        # A class can't be taught today from a lesson in the Trash.
        await session.exec(
            update(Class)
            .where(col(Class.current_lesson_id).in_(lessons))  # type: ignore[arg-type]
            .values(current_lesson_id=None)
        )
    if kind == "class":
        await _sign_class_out(session, row, now)
    if kind == "student":
        await revoke_live_sessions(session, row.id, now)

    session.add(audit_entry(principal, f"{kind}.trashed", kind, row.id, name=name_of(kind, row)))
    await session.commit()
    return row


# --- taking things out -----------------------------------------------------------------


def _conflict(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


async def restore(session: AsyncSession, principal: Principal, kind: str, row_id: uuid.UUID) -> Any:
    """Take something out of the Trash, as it was. Commits."""
    row = await _row(session, principal, kind, row_id)
    if row.deleted_at is None:
        raise _not_found()
    when = row.deleted_at

    if kind == "lesson":
        unit = await session.get(Unit, row.unit_id)
        if unit is not None and unit.deleted_at is not None:
            raise _conflict("Its unit is in the Trash too. Restore the unit.")
    if kind == "unit":
        course = await session.get(Course, row.course_id)
        if course is not None and course.deleted_at is not None:
            raise _conflict("Its course is in the Trash too. Restore the course.")

    group: list[Any] = [row]
    if kind == "folder":
        folders, files = await _folder_group(session, principal, row)
        group = [m for m in [*folders, *files] if m.deleted_at == when]
    elif kind == "unit":
        group += (
            await session.exec(
                select(Lesson).where(Lesson.unit_id == row.id, Lesson.deleted_at == when)
            )
        ).all()
    elif kind == "course":
        units = (
            await session.exec(
                select(Unit).where(Unit.course_id == row.id, Unit.deleted_at == when)
            )
        ).all()
        group += units
        if units:
            group += (
                await session.exec(
                    select(Lesson).where(
                        col(Lesson.unit_id).in_([u.id for u in units]), Lesson.deleted_at == when
                    )
                )
            ).all()

    if kind == "homework":
        # Its problems come back with it. One may have followed it into the Trash, which
        # was allowed only because nothing else used it — but this homework does again.
        group += (
            await session.exec(
                select(Item)
                .join(SetItem, col(SetItem.item_id) == Item.id)
                .where(SetItem.set_id == row.set_id, col(Item.deleted_at).is_not(None))
            )
        ).all()

    for member in group:
        take_out(member)
        session.add(member)
    if kind in FILE_KINDS:
        await _reparent(session, row)

    session.add(audit_entry(principal, f"{kind}.restored", kind, row.id, name=name_of(kind, row)))
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise _conflict(
            "Something with that name is already there. Rename it, then restore this."
        ) from exc
    await session.refresh(row)
    return row


async def _reparent(session: AsyncSession, row: Any) -> None:
    """A restored file or folder whose folder is gone goes to the top level."""
    attribute = "folder_id" if hasattr(row, "folder_id") else "parent_id"
    parent_id = getattr(row, attribute)
    if parent_id is None:
        return
    folder_model = (
        StudentFolder if isinstance(row, StudentDocument | StudentFolder) else TeacherFolder
    )
    parent = await session.get(folder_model, parent_id)
    if parent is None or parent.status != DocumentStatus.ACTIVE:
        setattr(row, attribute, None)


# --- for good ---------------------------------------------------------------------------


async def _erase(session: AsyncSession, kind: str, row: Any) -> Erased:
    """Delete a trashed row and its group for good, through `app.erase`."""
    when = row.deleted_at
    if kind == "class":
        return await erase_class(session, row.id)
    if kind == "student":
        return await erase_student(session, row.id)
    if kind == "problem":
        return await erase_item(session, row.id)
    if kind == "homework":
        return await erase_assignment(session, row.id)
    if kind == "lesson":
        return await erase_lessons(session, [row.id])
    if kind == "unit":
        return await erase_units(session, [row.id])
    if kind == "course":
        return await erase_course(session, row.id)
    student = isinstance(row, StudentDocument | StudentFolder)
    erase_files = erase_student_files if student else erase_teacher_files
    if kind == "file":
        return await erase_files(session, [row.id], [])
    owner = Principal(
        kind="student" if student else "teacher",
        subject_id=row.student_id if student else row.user_id,
        centre_id=row.centre_id,
    )
    folders, files = await _folder_group(session, owner, row)
    return await erase_files(
        session,
        [f.id for f in files if f.deleted_at == when],
        [f.id for f in folders if f.deleted_at == when],
    )


def may_purge(principal: Principal, kind: str, row: Any) -> bool:
    if principal.is_student:
        return False
    owner = principal.role == UserRole.OWNER
    if kind in NAMED_PURGE:
        return owner
    if kind in FILE_KINDS:
        return True  # `_row` has already checked they are the teacher's own
    return owner or principal.subject_id in (row.deleted_by, getattr(row, "created_by", None))


async def purge(
    session: AsyncSession,
    principal: Principal,
    kind: str,
    row_id: uuid.UUID,
    confirm_name: str | None = None,
) -> Erased:
    """Delete something in the Trash for good, now. Commits."""
    row = await _row(session, principal, kind, row_id)
    if row.deleted_at is None:
        raise _not_found()
    if not may_purge(principal, kind, row):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the centre’s owner can delete this for good."
            if kind in NAMED_PURGE
            else "Only the owner, or whoever deleted or made it, can delete this for good.",
        )
    name = name_of(kind, row)
    if kind in NAMED_PURGE and not names_match(confirm_name or "", name):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Type the name exactly to confirm.",
        )
    if kind == "problem":
        # Something restored since may use it again; deleting it now would take that
        # homework's question, and every child's answer to it, with it.
        where = await _problem_in_use(session, row.id)
        if where is not None:
            raise _conflict(f"It’s used again in {where}, so it can’t be deleted for good.")
    erased = await _erase(session, kind, row)
    # A child's name never goes into the record of their deletion (as Delete entirely).
    payload = (
        {"rows": erased.counts} if kind == "student" else {"name": name, "rows": erased.counts}
    )
    session.add(audit_entry(principal, f"{kind}.purged", kind, row_id, **payload))
    await session.commit()
    return erased


# --- what is in it -----------------------------------------------------------------------


@dataclass
class Entry:
    kind: str
    id: uuid.UUID
    name: str
    detail: str | None
    deleted_at: datetime
    deleted_by: str | None
    purge_after: datetime
    can_purge: bool
    needs_name: bool


async def _names(session: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    """Who deleted what: a teacher's or a child's name."""
    if not ids:
        return {}
    users = (await session.exec(select(User).where(col(User.id).in_(ids)))).all()
    students = (await session.exec(select(Student).where(col(Student.id).in_(ids)))).all()
    return {u.id: u.display_name for u in users} | {s.id: s.display_name for s in students}


async def list_trash(session: AsyncSession, principal: Principal) -> list[Entry]:
    """Everything in the Trash this caller can see, newest first; groups by their top."""
    rows: list[tuple[str, Any]] = []

    async def trashed(kind: str, *where: Any) -> list[Any]:
        model = _model(kind, principal)
        return list(
            (
                await session.exec(
                    select(model).where(
                        model.centre_id == principal.centre_id,
                        col(model.deleted_at).is_not(None),
                        *where,
                    )
                )
            ).all()
        )

    if principal.is_teacher:
        rows += [("class", r) for r in await trashed("class")]
        rows += [("student", r) for r in await trashed("student")]
        rows += [("problem", r) for r in await trashed("problem", col(Item.parent_id).is_(None))]
        courses = await trashed("course")
        units = await trashed("unit")
        rows += [("course", r) for r in courses]
        rows += [("unit", r) for r in units if not _same_group(r, courses, "course_id")]
        rows += [
            ("lesson", r) for r in await trashed("lesson") if not _same_group(r, units, "unit_id")
        ]
        rows += [
            ("homework", r)
            for r in await trashed("homework", Assignment.mode != AssignmentMode.CLASSWORK)
        ]
        owner_column = TeacherDocument.user_id
        folder_owner = TeacherFolder.user_id
    else:
        owner_column = StudentDocument.student_id
        folder_owner = StudentFolder.student_id
    folders = await trashed("folder", folder_owner == principal.subject_id)
    rows += [("folder", r) for r in folders if not _same_group(r, folders, "parent_id")]
    rows += [
        ("file", r)
        for r in await trashed("file", owner_column == principal.subject_id)
        if not _same_group(r, folders, "folder_id")
    ]

    names = await _names(session, {r.deleted_by for _, r in rows if r.deleted_by})
    classes = (
        {
            c.id: c.name
            for c in (
                await session.exec(
                    select(Class).where(
                        col(Class.id).in_([r.class_id for k, r in rows if k == "homework"])
                    )
                )
            ).all()
        }
        if any(k == "homework" for k, _ in rows)
        else {}
    )
    entries = [
        Entry(
            kind=kind,
            id=row.id,
            name=name_of(kind, row),
            detail=_detail(kind, row, classes),
            deleted_at=row.deleted_at,
            deleted_by=names.get(row.deleted_by) if row.deleted_by else None,
            purge_after=row.deleted_at + timedelta(days=TRASH_DAYS),
            can_purge=may_purge(principal, kind, row),
            needs_name=kind in NAMED_PURGE,
        )
        for kind, row in rows
    ]
    return sorted(entries, key=lambda e: e.deleted_at, reverse=True)


def _same_group(row: Any, parents: list[Any], attribute: str) -> bool:
    """Whether this row went into the Trash with its parent, which stands for it."""
    parent_id = getattr(row, attribute)
    return any(p.id == parent_id and p.deleted_at == row.deleted_at for p in parents)


def _detail(kind: str, row: Any, classes: dict[uuid.UUID, str]) -> str | None:
    if kind == "homework":
        what = "Quiz" if row.mode == AssignmentMode.QUIZ else "Homework"
        return f"{what} · {classes.get(row.class_id, '')}".rstrip(" ·")
    return None


# --- the 30-day clock ---------------------------------------------------------------------

# Children first, so a group's top purges its members before they are reached on their own.
_EXPIRY_ORDER: list[tuple[str, Any, str]] = [
    ("file", StudentDocument, "student"),
    ("folder", StudentFolder, "student"),
    ("file", TeacherDocument, "teacher"),
    ("folder", TeacherFolder, "teacher"),
    ("homework", Assignment, "teacher"),
    ("lesson", Lesson, "teacher"),
    ("unit", Unit, "teacher"),
    ("course", Course, "teacher"),
    ("problem", Item, "teacher"),
    ("student", Student, "teacher"),
    ("class", Class, "teacher"),
]


async def purge_expired(session: AsyncSession, now: datetime | None = None) -> int:
    """Delete for good everything that has been in the Trash longer than `TRASH_DAYS`.
    One commit per thing, so one failure doesn't hold up the rest. Returns how many went."""
    cutoff = (now or utcnow()) - timedelta(days=TRASH_DAYS)
    purged = 0
    for kind, model, _ in _EXPIRY_ORDER:
        due = (
            await session.exec(
                select(model.id).where(
                    col(model.deleted_at).is_not(None), model.deleted_at < cutoff
                )
            )
        ).all()
        for row_id in due:
            row = await session.get(model, row_id)
            if row is None or row.deleted_at is None:
                continue  # went with its group already
            if kind == "problem" and row.parent_id is not None:
                continue
            name = None if kind == "student" else name_of(kind, row)
            centre_id = row.centre_id
            if kind == "problem" and await _problem_in_use(session, row.id) is not None:
                # In use again (a homework restored since): the clock must not take a
                # live question and its answers. It comes out of the Trash instead.
                take_out(row)
                session.add(row)
                session.add(
                    AuditLog(
                        centre_id=centre_id,
                        actor_type=ActorType.SYSTEM,
                        action="problem.kept",
                        target_type=kind,
                        target_id=row_id,
                        payload={"name": name, "reason": "in use again"},
                    )
                )
                await session.commit()
                continue
            try:
                erased = await _erase(session, kind, row)
                session.add(
                    AuditLog(
                        centre_id=centre_id,
                        actor_type=ActorType.SYSTEM,
                        action=f"{kind}.purged",
                        target_type=kind,
                        target_id=row_id,
                        payload={"rows": erased.counts, "after_days": TRASH_DAYS}
                        | ({"name": name} if name else {}),
                    )
                )
                await session.commit()
                purged += 1
            except Exception:  # one bad row must not stop the rest; it is retried next time
                await session.rollback()
                log.exception("could not purge %s %s from the Trash", kind, row_id)
    return purged


PURGE_EVERY_SECONDS = 60 * 60


@contextlib.asynccontextmanager
async def purge_loop(_app: Any) -> AsyncIterator[None]:
    """An app lifespan that runs `purge_expired` hourly while the server is up.

    In process, like the live hub and the quiz timers: production is exactly one machine
    (root CLAUDE.md). A restart just means the next pass is an hour later; nothing is lost,
    because the clock is `deleted_at`, not this loop.
    """
    from app.db import async_session_factory

    async def run() -> None:
        while True:
            # Wait first: a server that has only just started (or a test app that is about
            # to stop) has better things to do, and nothing here is urgent.
            await asyncio.sleep(PURGE_EVERY_SECONDS)
            try:
                async with async_session_factory() as session:
                    gone = await purge_expired(session)
                if gone:
                    log.info("emptied %d thing(s) from the Trash after %d days", gone, TRASH_DAYS)
            except Exception:  # keep the loop alive; the next pass tries again
                log.exception("the Trash purge pass failed")

    task = asyncio.create_task(run())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
