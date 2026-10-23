"""The owner's Teachers page: who teaches here, who is invited, and taking access away.

Only the centre's **owner** reaches these routes (Ken's decision, 10 Oct 2026). A teacher
gets 403, a student gets 403, and everything is scoped to the owner's own centre.

Inviting sends no email. The owner tells the teacher and copies them the sign-up link;
the app holds no Supabase service key, so it cannot create accounts or send mail on
anyone's behalf. Removing a teacher disables their `users` row, which `load_teacher`
checks on every request — they are out on their next click. Nothing is deleted: their
classes and marking stay, and inviting the same address again brings them back.

**Make owner** (Ken's decision, 23 Oct 2026) hands the centre to another teacher. There is
one owner at a time: the new owner gets the role and the old one becomes an ordinary
teacher, keeping everything they made. It happens at once — confirmed by typing the new
owner's name, with no accept step — and, since `load_teacher` reads the role on every
request, both feel it on their next click. Only the new owner can hand it back.
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import CurrentTeacher, Principal
from app.auth.provisioning import normalise_email, pending_invite
from app.db import get_session
from app.erase import names_match
from app.live.hub import hub
from app.models import (
    ActorType,
    AuditLog,
    InviteStatus,
    TeacherInvite,
    User,
    UserRole,
    UserStatus,
)

router = APIRouter(prefix="/teachers", tags=["teachers"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]


async def require_owner(principal: CurrentTeacher) -> Principal:
    if principal.role != UserRole.OWNER:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the centre’s owner can manage teachers.",
        )
    return principal


CurrentOwner = Annotated[Principal, Depends(require_owner)]


class TeacherRowOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    role: UserRole
    is_you: bool


class InviteOut(BaseModel):
    id: uuid.UUID
    email: str
    created_at: datetime


class TeachersOut(BaseModel):
    teachers: list[TeacherRowOut]
    invites: list[InviteOut]


class TransferIn(BaseModel):
    """The new owner's name, typed out, as the confirmation (case and spaces ignored)."""

    confirm_name: str = Field(min_length=1, max_length=200)


class InviteIn(BaseModel):
    email: str = Field(min_length=3, max_length=320)


def _audit(owner: Principal, action: str, target_type: str, target_id: uuid.UUID, **payload):
    return AuditLog(
        centre_id=owner.centre_id,
        actor_type=ActorType.USER,
        actor_id=owner.subject_id,
        action=action,
        target_type=target_type,
        target_id=target_id,
        payload=payload,
    )


def _invite_out(invite: TeacherInvite) -> InviteOut:
    return InviteOut(id=invite.id, email=invite.email, created_at=invite.created_at)


@router.get("", response_model=TeachersOut)
async def list_teachers(owner: CurrentOwner, session: SessionDep) -> TeachersOut:
    """Active teachers, then invites nobody has used yet."""
    return await _teachers_out(session, owner)


async def _teachers_out(session: AsyncSession, owner: Principal) -> TeachersOut:
    users = (
        await session.exec(
            select(User)
            .where(User.centre_id == owner.centre_id, User.status == UserStatus.ACTIVE)
            .order_by(col(User.created_at))
        )
    ).all()
    invites = (
        await session.exec(
            select(TeacherInvite)
            .where(
                TeacherInvite.centre_id == owner.centre_id,
                TeacherInvite.status == InviteStatus.PENDING,
            )
            .order_by(col(TeacherInvite.created_at))
        )
    ).all()
    return TeachersOut(
        teachers=[
            TeacherRowOut(
                id=u.id,
                email=u.email,
                display_name=u.display_name,
                role=u.role,
                is_you=u.id == owner.subject_id,
            )
            for u in users
        ],
        invites=[_invite_out(i) for i in invites],
    )


@router.post("/invites", response_model=InviteOut, status_code=status.HTTP_201_CREATED)
async def invite_teacher(body: InviteIn, owner: CurrentOwner, session: SessionDep) -> InviteOut:
    email = normalise_email(body.email)
    local, at, domain = email.partition("@")
    if not at or not local or "." not in domain or " " in email:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="That doesn’t look like an email address.",
        )

    active = (
        await session.exec(
            select(User).where(
                User.centre_id == owner.centre_id,
                User.email == email,
                User.status == UserStatus.ACTIVE,
            )
        )
    ).first()
    if active is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{email} is already a teacher here.",
        )

    # Inviting twice is the same invite, not an error: the owner may simply have lost
    # the link they were going to send.
    existing = await pending_invite(session, owner.centre_id, email)
    if existing is not None:
        return _invite_out(existing)

    invite = TeacherInvite(centre_id=owner.centre_id, email=email, invited_by=owner.subject_id)
    session.add(invite)
    try:
        await session.flush()
    except IntegrityError:
        # Two clicks at once: the partial unique index let one through. Use that one.
        await session.rollback()
        existing = await pending_invite(session, owner.centre_id, email)
        if existing is None:  # pragma: no cover — the index only fails on a pending row
            raise
        return _invite_out(existing)
    session.add(_audit(owner, "teacher.invited", "teacher_invite", invite.id, email=email))
    await session.commit()
    return _invite_out(invite)


@router.post("/invites/{invite_id}/revoke", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_invite(invite_id: uuid.UUID, owner: CurrentOwner, session: SessionDep) -> None:
    invite = await session.get(TeacherInvite, invite_id)
    # Another centre's invite is "not found", never "forbidden": the difference would
    # confirm that the id exists.
    if invite is None or invite.centre_id != owner.centre_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="invite not found")
    if invite.status != InviteStatus.PENDING:
        return
    invite.status = InviteStatus.REVOKED
    session.add(invite)
    session.add(
        _audit(owner, "teacher.invite_revoked", "teacher_invite", invite.id, email=invite.email)
    )
    await session.commit()


@router.post("/{user_id}/remove", status_code=status.HTTP_204_NO_CONTENT)
async def remove_teacher(user_id: uuid.UUID, owner: CurrentOwner, session: SessionDep) -> None:
    user = await session.get(User, user_id)
    if user is None or user.centre_id != owner.centre_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="teacher not found")
    if user.id == owner.subject_id:
        # The one way to lock everybody out of the Teachers page for good.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="You can’t remove yourself."
        )
    if user.status == UserStatus.DISABLED:
        return
    user.status = UserStatus.DISABLED
    session.add(user)
    session.add(_audit(owner, "teacher.removed", "user", user.id, email=user.email))
    await session.commit()
    # Open Live views check the account only when they connect: close them now.
    await hub.kick_teacher(user.id)


@router.post("/{user_id}/make-owner", response_model=TeachersOut)
async def make_owner(
    user_id: uuid.UUID, body: TransferIn, owner: CurrentOwner, session: SessionDep
) -> TeachersOut:
    """Hand the centre to another teacher; the caller becomes a teacher. See the module
    docstring. Returns the list as the new owner would see it, for the page to redraw once
    before the caller (no longer the owner) leaves it."""
    user = await session.get(User, user_id)
    # Another centre's teacher, or a removed one, is "not found": ownership can only go to
    # someone who can sign in here.
    if user is None or user.centre_id != owner.centre_id or user.status != UserStatus.ACTIVE:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="teacher not found")
    if user.id == owner.subject_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="You’re already the owner."
        )
    if not names_match(body.confirm_name, user.display_name):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Type their name exactly to confirm.",
        )
    previous = await session.get(User, owner.subject_id)
    assert previous is not None  # `CurrentOwner` loaded it this request
    user.role = UserRole.OWNER
    previous.role = UserRole.TEACHER
    session.add_all([user, previous])
    session.add(
        _audit(
            owner,
            "teacher.ownership_transferred",
            "user",
            user.id,
            to=str(user.id),
            to_email=user.email,
            **{"from": str(previous.id)},
        )
    )
    await session.commit()
    return await _teachers_out(session, owner)
