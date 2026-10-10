"""Class CRUD, scoped to the signed-in teacher's centre.

Every lookup goes through `app.scoping`, which applies the `centre_id` filter. Nothing in
this module builds its own query against `classes` — see the module docstring there for
why that rule exists.

Archive rather than delete, throughout. A class holds a term of enrolments and, later,
attempts and events; deleting one would vaporise the history Phase 8 reads.
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlmodel import select, update
from sqlmodel.ext.asyncio.session import AsyncSession

from app.audit import audit_entry
from app.auth.principal import CurrentOwner, CurrentTeacher, Principal
from app.auth.student_session import revoke_live_sessions
from app.classwork import ensure_classwork
from app.db import get_session
from app.erase import EraseIn, erase_class, names_match
from app.join_codes import mint_code, rotate_code
from app.models import (
    AuditLog,
    Class,
    ClassJoinCode,
    ClassStatus,
    ClassTeacher,
    ClassTeacherRole,
    CurriculumStatus,
    Enrolment,
    EnrolmentStatus,
)
from app.models.base import utcnow
from app.scoping import (
    get_live_join_code,
    get_owned_class,
    get_owned_course,
    get_owned_lesson,
    get_owned_unit,
    list_owned_classes,
)

router = APIRouter(prefix="/classes", tags=["classes"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]


class ClassIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    term_label: str | None = Field(default=None, max_length=60)


class ClassPatch(BaseModel):
    """Every field optional — an absent field means "leave it alone"."""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    term_label: str | None = Field(default=None, max_length=60)


class ClassCurriculumIn(BaseModel):
    """The course a class follows and the lesson it is on. Both fields are always sent.

    A PUT rather than a PATCH field on the class: the two values constrain each other (the
    lesson must be in the course), so they are set together and validated together.
    """

    course_id: uuid.UUID | None
    current_lesson_id: uuid.UUID | None


class ClassOut(BaseModel):
    id: uuid.UUID
    name: str
    term_label: str | None
    status: ClassStatus
    course_id: uuid.UUID | None
    current_lesson_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    # The caller is one of this class's teachers (`class_teachers`). Drives "My classes";
    # it does not gate anything — every teacher at the centre can open every class.
    is_mine: bool = False

    @classmethod
    def build(cls, record: Class, is_mine: bool = False) -> "ClassOut":
        return cls(
            id=record.id,
            name=record.name,
            term_label=record.term_label,
            status=record.status,
            course_id=record.course_id,
            current_lesson_id=record.current_lesson_id,
            created_at=record.created_at,
            updated_at=record.updated_at,
            is_mine=is_mine,
        )


class ClassDetailOut(ClassOut):
    """A class plus its join code.

    Separate from `ClassOut` so the list route does not have to fetch a code per class.
    A teacher reads the code off the class itself, not off a list of twelve of them.
    Mirrors the StudentOut / StudentDetailOut split in the roster router.
    """

    join_code: str | None

    @classmethod
    def build_detail(
        cls, record: Class, code: ClassJoinCode | None, is_mine: bool = False
    ) -> "ClassDetailOut":
        return cls(
            **ClassOut.build(record, is_mine).model_dump(),
            join_code=code.code if code else None,
        )


async def my_class_ids(session: AsyncSession, principal: Principal) -> set[uuid.UUID]:
    """The classes the caller teaches — one query, for marking `is_mine`."""
    rows = await session.exec(
        select(ClassTeacher.class_id).where(ClassTeacher.user_id == principal.subject_id)
    )
    return set(rows.all())


async def _mine(session: AsyncSession, principal: Principal, class_id: uuid.UUID) -> bool:
    return class_id in await my_class_ids(session, principal)


def _audit(principal: Principal, action: str, class_id: uuid.UUID, **payload: object) -> AuditLog:
    return audit_entry(principal, action, "class", class_id, **payload)


@router.post("", response_model=ClassDetailOut, status_code=status.HTTP_201_CREATED)
async def create_class(
    body: ClassIn, principal: CurrentTeacher, session: SessionDep
) -> ClassDetailOut:
    """Create a class, with the join code it will keep for its whole life.

    The code is minted here rather than by a separate 'generate a code' action,
    because a class that exists but cannot be joined is not a state worth being able
    to reach. It is an attribute of the class, like its name.
    """
    record = Class(
        centre_id=principal.centre_id,
        name=body.name.strip(),
        term_label=body.term_label.strip() if body.term_label else None,
    )
    session.add(record)
    await session.flush()

    # The creator leads the class until someone says otherwise. Recording it now means
    # "whose class is this" is answerable without a backfill when an assignment UI lands.
    session.add(
        ClassTeacher(class_id=record.id, user_id=principal.subject_id, role=ClassTeacherRole.LEAD)
    )
    code = await mint_code(session, principal, record.id)
    session.add(
        _audit(principal, "class.created", record.id, name=record.name, join_code=code.code)
    )
    await session.commit()
    await session.refresh(record)
    return ClassDetailOut.build_detail(record, code, is_mine=True)


@router.get("", response_model=list[ClassOut])
async def list_classes(
    principal: CurrentTeacher, session: SessionDep, include_archived: bool = False
) -> list[ClassOut]:
    records = await list_owned_classes(session, principal, include_archived)
    mine = await my_class_ids(session, principal)
    return [ClassOut.build(record, record.id in mine) for record in records]


@router.get("/{class_id}", response_model=ClassDetailOut)
async def read_class(
    class_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> ClassDetailOut:
    record = await get_owned_class(session, principal, class_id)
    code = await get_live_join_code(session, principal, class_id)
    return ClassDetailOut.build_detail(record, code, await _mine(session, principal, record.id))


@router.patch("/{class_id}", response_model=ClassOut)
async def update_class(
    class_id: uuid.UUID, body: ClassPatch, principal: CurrentTeacher, session: SessionDep
) -> ClassOut:
    record = await get_owned_class(session, principal, class_id)

    changed: dict[str, object] = {}
    # exclude_unset distinguishes "term_label": null (clear it) from an absent field
    # (leave it), which a plain `if body.term_label` cannot.
    fields = body.model_dump(exclude_unset=True)
    if "name" in fields and fields["name"] is not None:
        record.name = body.name.strip()  # type: ignore[union-attr]
        changed["name"] = record.name
    if "term_label" in fields:
        record.term_label = body.term_label.strip() if body.term_label else None
        changed["term_label"] = record.term_label

    if changed:
        session.add(record)
        session.add(_audit(principal, "class.renamed", record.id, **changed))
        await session.commit()
        await session.refresh(record)
    return ClassOut.build(record, await _mine(session, principal, record.id))


@router.post("/{class_id}/archive", response_model=ClassOut)
async def archive_class(
    class_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> ClassOut:
    """Close a class: hide it from the default list, revoke its join codes, sign its
    children out. This is the class page's "Remove class".

    Enrolments are left untouched. They are the record of who was actually in the class
    this term, which is exactly what Phase 8 mastery reads — withdrawing them on archive
    would overwrite history to tidy up a status field.

    Children still signed in are signed out, as when one child is removed from a class: a
    session belongs to the child, so without this they would carry on working in a class
    that no longer exists for anyone else. They can sign in to any other class they are in.
    """
    record = await get_owned_class(session, principal, class_id)
    record.status = ClassStatus.ARCHIVED
    session.add(record)

    # A code for a finished class should not still open a door.
    now = utcnow()
    live_codes = (
        await session.exec(
            select(ClassJoinCode).where(
                ClassJoinCode.class_id == record.id,
                ClassJoinCode.revoked_at.is_(None),  # type: ignore[union-attr]
            )
        )
    ).all()
    if live_codes:
        await session.exec(
            update(ClassJoinCode)
            .where(
                ClassJoinCode.class_id == record.id,
                ClassJoinCode.revoked_at.is_(None),  # type: ignore[union-attr]
            )
            .values(revoked_at=now)
        )

    enrolled = (
        await session.exec(
            select(Enrolment.student_id).where(
                Enrolment.class_id == record.id,
                Enrolment.status == EnrolmentStatus.ACTIVE,
            )
        )
    ).all()
    sessions_revoked = 0
    for student_id in enrolled:
        sessions_revoked += await revoke_live_sessions(session, student_id, now)

    session.add(
        _audit(
            principal,
            "class.archived",
            record.id,
            join_codes_revoked=len(live_codes),
            sessions_revoked=sessions_revoked,
        )
    )
    await session.commit()
    await session.refresh(record)
    return ClassOut.build(record, await _mine(session, principal, record.id))


@router.post("/{class_id}/delete", status_code=status.HTTP_204_NO_CONTENT)
async def delete_class(
    class_id: uuid.UUID, body: EraseIn, principal: CurrentOwner, session: SessionDep
) -> None:
    """Delete a class entirely: it and its homework, quizzes, submissions and marks (Ken's
    decision, 11 Oct 2026). Student accounts and their own files stay — a child can be in
    other classes. Owner only, with the class name typed out. See `app.erase`.
    """
    record = await get_owned_class(session, principal, class_id)
    if not names_match(body.confirm_name, record.name):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Type the class name exactly to confirm.",
        )
    # Sign its children out first, as archiving does.
    enrolled = (
        await session.exec(
            select(Enrolment.student_id).where(
                Enrolment.class_id == record.id, Enrolment.status == EnrolmentStatus.ACTIVE
            )
        )
    ).all()
    for student_id in enrolled:
        await revoke_live_sessions(session, student_id)
    erased = await erase_class(session, record.id)
    session.add(_audit(principal, "class.deleted", class_id, rows=erased.counts))
    await session.commit()


@router.post("/{class_id}/join-code/rotate", response_model=ClassDetailOut)
async def rotate_join_code(
    class_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> ClassDetailOut:
    """Replace the class's join code, invalidating the old one immediately.

    The remedy for a code that has got out — read out to the wrong room, photographed off
    a whiteboard. There is no standalone revoke to pair with this: rotating leaves the
    class joinable, whereas revoking alone would leave a class with children on its roster
    and no way in, which is not a state worth being one click away.
    """
    await get_owned_class(session, principal, class_id)
    previous = await get_live_join_code(session, principal, class_id)
    code = await rotate_code(session, principal, class_id)
    session.add(
        _audit(
            principal,
            "class.join_code_rotated",
            class_id,
            code=code.code,
            replaced=previous.code if previous else None,
        )
    )
    await session.commit()
    record = await get_owned_class(session, principal, class_id)
    return ClassDetailOut.build_detail(record, code, await _mine(session, principal, record.id))


@router.post("/{class_id}/unarchive", response_model=ClassOut)
async def unarchive_class(
    class_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> ClassOut:
    """Undo an archive.

    Revoked join codes stay revoked — reviving a code nobody expects to work again is a
    worse surprise than issuing a fresh one.
    """
    record = await get_owned_class(session, principal, class_id)
    record.status = ClassStatus.ACTIVE
    session.add(record)
    session.add(_audit(principal, "class.unarchived", record.id))
    await session.commit()
    await session.refresh(record)
    return ClassOut.build(record, await _mine(session, principal, record.id))


def _unprocessable(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=detail)


@router.put("/{class_id}/curriculum", response_model=ClassOut)
async def set_class_curriculum(
    class_id: uuid.UUID, body: ClassCurriculumIn, principal: CurrentTeacher, session: SessionDep
) -> ClassOut:
    """Choose the class's course and today's lesson.

    The lesson must sit in the chosen course, and both must be active — a class pointed at
    an archived lesson would show children a ladder the teacher can no longer see to edit.
    A lesson with no course is refused rather than inferred: guessing the course from the
    lesson would silently change what the class follows.

    Ids from another centre come back 404 through scoping, as everywhere, rather than as
    a 422 that would confirm they exist.
    """
    record = await get_owned_class(session, principal, class_id)

    if body.course_id is not None:
        course = await get_owned_course(session, principal, body.course_id)
        if course.status != CurriculumStatus.ACTIVE:
            raise _unprocessable("That course is archived")
    if body.current_lesson_id is not None:
        if body.course_id is None:
            raise _unprocessable("Choose a course before choosing a lesson")
        lesson = await get_owned_lesson(session, principal, body.current_lesson_id)
        unit = await get_owned_unit(session, principal, lesson.unit_id)
        if unit.course_id != body.course_id:
            raise _unprocessable("That lesson is not in this course")
        if CurriculumStatus.ARCHIVED in (lesson.status, unit.status):
            raise _unprocessable("That lesson is archived")

    if (record.course_id, record.current_lesson_id) != (body.course_id, body.current_lesson_id):
        record.course_id = body.course_id
        record.current_lesson_id = body.current_lesson_id
        session.add(record)
        session.add(
            _audit(
                principal,
                "class.curriculum_set",
                record.id,
                course_id=str(body.course_id) if body.course_id else None,
                current_lesson_id=str(body.current_lesson_id) if body.current_lesson_id else None,
            )
        )
        # Today's lesson opens its ladder for the class, if it has one (app/classwork.py).
        await ensure_classwork(session, principal, record)
        await session.commit()
        await session.refresh(record)
    return ClassOut.build(record, await _mine(session, principal, record.id))
