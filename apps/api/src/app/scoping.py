"""Centre-scoped lookups — the one place the tenancy filter lives.

**Routers must not build their own queries against a centre-owned table.** Every read of
`classes`, `students`, `enrolments` or `class_join_codes` goes through a helper here that
takes a `Principal` and applies `centre_id` itself.

The reason is the shape of the realistic failure. Nobody forgets the filter today, while
there are two routes and the boundary is the thing being built. The omission happens in
six months, on the seventh route, added quickly — and one missing
`.where(centre_id == ...)` is a cross-tenant read of children's records. Making the
filter something a route cannot express without is cheaper than remembering it.

The review rule that falls out: a bare `select(Class)` in a router is a bug.

**Not found and not yours return the same 404.** A 403 would confirm that an id exists,
which is information the caller has no legitimate way to hold.
"""

import uuid
from collections.abc import Sequence

from fastapi import HTTPException, status
from sqlmodel import func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import Principal
from app.models import (
    Centre,
    Class,
    ClassStatus,
    Enrolment,
    EnrolmentStatus,
    Student,
    StudentStatus,
)


def _not_found(what: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{what} not found")


async def get_centre(session: AsyncSession, principal: Principal) -> Centre:
    centre = await session.get(Centre, principal.centre_id)
    if centre is None:  # pragma: no cover — a principal cannot exist without its centre
        raise _not_found("centre")
    return centre


async def get_owned_class(
    session: AsyncSession, principal: Principal, class_id: uuid.UUID
) -> Class:
    """A class in the principal's centre, or 404.

    Both halves of the filter matter: `id` finds it, `centre_id` decides whether the
    caller is allowed to know it exists.
    """
    found = (
        await session.exec(
            select(Class).where(
                Class.id == class_id,
                Class.centre_id == principal.centre_id,
            )
        )
    ).one_or_none()
    if found is None:
        raise _not_found("class")
    return found


async def list_owned_classes(
    session: AsyncSession, principal: Principal, include_archived: bool = False
) -> Sequence[Class]:
    """Every class in the principal's centre, newest first.

    Teachers at a centre see each other's classes: they cover each other's lessons, and a
    per-teacher filter would lock a covering teacher out of the roster they are about to
    need. `class_teachers` records who leads what; it does not gate visibility.

    Ordering is by id, which is UUIDv7 and therefore already in creation order — no
    separate sort column, and no tie-break problem when two classes are created in the
    same transaction.
    """
    statement = select(Class).where(Class.centre_id == principal.centre_id)
    if not include_archived:
        statement = statement.where(Class.status == ClassStatus.ACTIVE)
    statement = statement.order_by(Class.id.desc())  # type: ignore[attr-defined]
    return (await session.exec(statement)).all()


async def get_owned_student(
    session: AsyncSession, principal: Principal, student_id: uuid.UUID
) -> Student:
    """A student in the principal's centre, or 404.

    The same two-part filter as `get_owned_class`, and the same reasoning — except the
    stakes are higher here, because the row is a child's record rather than a class name.
    """
    found = (
        await session.exec(
            select(Student).where(
                Student.id == student_id,
                Student.centre_id == principal.centre_id,
            )
        )
    ).one_or_none()
    if found is None:
        raise _not_found("student")
    return found


async def list_owned_students(
    session: AsyncSession, principal: Principal, include_archived: bool = False
) -> Sequence[Student]:
    """Every student at the principal's centre, alphabetically.

    Deliberately *not* `id.desc()` like the class list. A roster is read down the page
    during roll call, so alphabetical order is the useful one; `lower()` keeps a
    lowercase-typed name from sorting after every capitalised one.

    Students in no class at all are included — a child can exist at the centre between
    terms, and a list that hid them would make them unreachable to re-enrol.
    """
    statement = select(Student).where(Student.centre_id == principal.centre_id)
    if not include_archived:
        statement = statement.where(Student.status == StudentStatus.ACTIVE)
    statement = statement.order_by(func.lower(Student.display_name))
    return (await session.exec(statement)).all()


async def list_class_roster(
    session: AsyncSession,
    principal: Principal,
    class_id: uuid.UUID,
    include_withdrawn: bool = False,
) -> Sequence[tuple[Enrolment, Student]]:
    """The students enrolled in one of the principal's classes, alphabetically.

    Call `get_owned_class` first if the class itself needs to 404 — this returns an empty
    list for a class in another centre, which is right for a join but says nothing about
    whether the class exists.

    Both `Class.centre_id` and `Student.centre_id` are filtered. That is belt and braces:
    nothing should ever write an enrolment joining two centres, and if something did, this
    is the query that must not return it.
    """
    statement = (
        select(Enrolment, Student)
        .join(Student, Enrolment.student_id == Student.id)  # type: ignore[arg-type]
        .join(Class, Enrolment.class_id == Class.id)  # type: ignore[arg-type]
        .where(
            Enrolment.class_id == class_id,
            Class.centre_id == principal.centre_id,
            Student.centre_id == principal.centre_id,
        )
    )
    if not include_withdrawn:
        statement = statement.where(Enrolment.status == EnrolmentStatus.ACTIVE)
    statement = statement.order_by(func.lower(Student.display_name))
    return (await session.exec(statement)).all()


async def list_student_enrolments(
    session: AsyncSession, principal: Principal, student_id: uuid.UUID
) -> Sequence[tuple[Enrolment, Class]]:
    """Every class one student has been in, newest first, withdrawn ones included.

    Withdrawn enrolments are always returned: "which classes has this child been in" is a
    question about their history, and hiding the withdrawn ones would answer a different
    one. It is also what a teacher needs to see before archiving them.
    """
    statement = (
        select(Enrolment, Class)
        .join(Class, Enrolment.class_id == Class.id)  # type: ignore[arg-type]
        .where(
            Enrolment.student_id == student_id,
            Class.centre_id == principal.centre_id,
        )
        .order_by(Enrolment.id.desc())  # type: ignore[attr-defined]
    )
    return (await session.exec(statement)).all()


async def get_enrolment(
    session: AsyncSession, principal: Principal, class_id: uuid.UUID, student_id: uuid.UUID
) -> Enrolment | None:
    """One student's enrolment in one class, or None.

    Returns None rather than raising, because callers need to tell "never enrolled"
    (insert) apart from "withdrawn" (reactivate) — `uq_enrolments_class_student` ignores
    status, so a withdrawn row cannot be replaced by a second insert.

    Tenancy is the caller's job here: both ids must already have come through
    `get_owned_class` and `get_owned_student`.
    """
    return (
        await session.exec(
            select(Enrolment).where(
                Enrolment.class_id == class_id,
                Enrolment.student_id == student_id,
            )
        )
    ).one_or_none()
