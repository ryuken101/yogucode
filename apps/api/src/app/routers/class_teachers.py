"""Who teaches a class: the Teachers box on the class page (Ken's decision, 10 Oct 2026).

A class can have several teachers, each **Lead** or **Assistant**, recorded in
`class_teachers`. This is organisation, not permission: every teacher at the centre can
still open every class (`app.scoping`), so a colleague covering a lesson is never locked
out. What the links drive is "My classes" on the Classes page and who is listed here.

Any teacher at the centre may change it, as they can everything else about a class; every
change is audited. Removing a link deletes the row — it is a staffing note, not a record
of a child — and the audit entry keeps the history. A class always keeps at least one
Lead. Teachers the owner has removed from the centre are hidden, not unlinked, so inviting
them back restores their classes too.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel import col, func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.audit import audit_entry
from app.auth.principal import CurrentTeacher, Principal
from app.db import get_session
from app.models import ClassTeacher, ClassTeacherRole, User, UserStatus
from app.scoping import get_owned_class

router = APIRouter(prefix="/classes", tags=["class teachers"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]


class ClassTeacherOut(BaseModel):
    user_id: uuid.UUID
    display_name: str
    email: str
    role: ClassTeacherRole
    is_you: bool


class ClassTeacherCandidateOut(BaseModel):
    user_id: uuid.UUID
    display_name: str
    email: str


class ClassTeacherIn(BaseModel):
    role: ClassTeacherRole


def _audit(principal: Principal, action: str, class_id: uuid.UUID, **payload: object):
    return audit_entry(principal, action, "class", class_id, **payload)


async def _active_teacher(session: AsyncSession, principal: Principal, user_id: uuid.UUID) -> User:
    """An active teacher at the caller's centre, or 404 — never someone else's staff."""
    user = (
        await session.exec(
            select(User).where(
                User.id == user_id,
                User.centre_id == principal.centre_id,
                User.status == UserStatus.ACTIVE,
            )
        )
    ).one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="teacher not found")
    return user


async def _leads(session: AsyncSession, class_id: uuid.UUID) -> int:
    return (
        await session.exec(
            select(func.count())
            .select_from(ClassTeacher)
            .join(User, col(User.id) == ClassTeacher.user_id)
            .where(
                ClassTeacher.class_id == class_id,
                ClassTeacher.role == ClassTeacherRole.LEAD,
                User.status == UserStatus.ACTIVE,
            )
        )
    ).one()


async def _listing(
    session: AsyncSession, principal: Principal, class_id: uuid.UUID
) -> list[ClassTeacherOut]:
    rows = (
        await session.exec(
            select(ClassTeacher, User)
            .join(User, col(User.id) == ClassTeacher.user_id)
            .where(ClassTeacher.class_id == class_id, User.status == UserStatus.ACTIVE)
            .order_by(col(ClassTeacher.role).desc(), col(User.display_name))
        )
    ).all()
    # Lead before Assistant ("lead" > "assistant" alphabetically, hence desc), then by name.
    return [
        ClassTeacherOut(
            user_id=user.id,
            display_name=user.display_name,
            email=user.email,
            role=link.role,
            is_you=user.id == principal.subject_id,
        )
        for link, user in rows
    ]


@router.get("/{class_id}/teachers", response_model=list[ClassTeacherOut])
async def list_class_teachers(
    class_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> list[ClassTeacherOut]:
    await get_owned_class(session, principal, class_id)
    return await _listing(session, principal, class_id)


@router.get("/{class_id}/teachers/candidates", response_model=list[ClassTeacherCandidateOut])
async def list_candidates(
    class_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> list[ClassTeacherCandidateOut]:
    """The centre's active teachers who are not on this class yet — the Add picker."""
    await get_owned_class(session, principal, class_id)
    on_class = select(ClassTeacher.user_id).where(ClassTeacher.class_id == class_id)
    users = (
        await session.exec(
            select(User)
            .where(
                User.centre_id == principal.centre_id,
                User.status == UserStatus.ACTIVE,
                col(User.id).not_in(on_class),
            )
            .order_by(col(User.display_name))
        )
    ).all()
    return [
        ClassTeacherCandidateOut(user_id=u.id, display_name=u.display_name, email=u.email)
        for u in users
    ]


@router.put("/{class_id}/teachers/{user_id}", response_model=list[ClassTeacherOut])
async def set_class_teacher(
    class_id: uuid.UUID,
    user_id: uuid.UUID,
    body: ClassTeacherIn,
    principal: CurrentTeacher,
    session: SessionDep,
) -> list[ClassTeacherOut]:
    """Add a teacher to the class, or change their role. Returns the new listing."""
    await get_owned_class(session, principal, class_id)
    user = await _active_teacher(session, principal, user_id)
    link = await session.get(ClassTeacher, (class_id, user.id))

    if link is None:
        session.add(ClassTeacher(class_id=class_id, user_id=user.id, role=body.role))
        session.add(
            _audit(
                principal,
                "class.teacher_added",
                class_id,
                user_id=str(user.id),
                role=body.role.value,
            )
        )
    elif ClassTeacherRole(link.role) != body.role:
        if (
            ClassTeacherRole(link.role) == ClassTeacherRole.LEAD
            and await _leads(session, class_id) <= 1
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Every class needs a Lead. Make someone else Lead first.",
            )
        link.role = body.role
        session.add(link)
        session.add(
            _audit(
                principal,
                "class.teacher_role_changed",
                class_id,
                user_id=str(user.id),
                role=body.role.value,
            )
        )
    await session.commit()
    return await _listing(session, principal, class_id)


@router.post("/{class_id}/teachers/{user_id}/remove", response_model=list[ClassTeacherOut])
async def remove_class_teacher(
    class_id: uuid.UUID, user_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> list[ClassTeacherOut]:
    """Take a teacher off the class. They can still open it, like any teacher here."""
    await get_owned_class(session, principal, class_id)
    link = await session.get(ClassTeacher, (class_id, user_id))
    if link is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not on this class")
    if (
        ClassTeacherRole(link.role) == ClassTeacherRole.LEAD
        and await _leads(session, class_id) <= 1
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Every class needs a Lead. Make someone else Lead first.",
        )
    await session.delete(link)
    session.add(_audit(principal, "class.teacher_removed", class_id, user_id=str(user_id)))
    await session.commit()
    return await _listing(session, principal, class_id)
