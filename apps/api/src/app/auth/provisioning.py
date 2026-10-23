"""First-sign-in provisioning for teachers, and who is allowed one.

**Who may have an account** (Ken's decision, 10 Oct 2026): an address with a pending
invite from the owner's Teachers page, or one in `TEACHER_EMAIL_ALLOWLIST` — which is now
only the bootstrap list, so the first owner can always get in. Supabase will create an
account for anyone (the anon key is public and sign-up is open there); this module is
where that account becomes a teacher, or doesn't. After provisioning, access is the
`users` row: active means in, disabled (removed by the owner) means out, on the next
request.

One academy, one centre. The centre named in config is created by whoever signs in
first, and every invited teacher after that joins the same one. A second teacher
signing in must never produce a second tenant — they would silently be unable to see
each other's classes, and merging afterwards means moving rows across the tenancy
boundary this whole design exists to keep intact.

Both inserts here race with themselves: two teachers can sign in for the first time at
the same moment, and one teacher's browser can fire two requests. Both are resolved by
letting the database decide — the unique constraints on `centres.slug` and
`users.supabase_user_id` are the arbiter — rather than by checking first and hoping.
"""

import uuid

from fastapi import HTTPException, status
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlmodel import func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.supabase_jwt import TeacherClaims
from app.config import Settings
from app.models import (
    ActorType,
    AuditLog,
    Centre,
    InviteStatus,
    TeacherInvite,
    User,
    UserRole,
    UserStatus,
    utcnow,
)

# Written for the teacher who just clicked their verification link, not for a developer.
NOT_INVITED = (
    "This email hasn’t been invited yet. Ask your centre’s owner to add you on their "
    "Teachers page, then sign in again."
)


def normalise_email(email: str) -> str:
    return email.strip().lower()


async def pending_invite(
    session: AsyncSession, centre_id: uuid.UUID, email: str
) -> TeacherInvite | None:
    return (
        await session.exec(
            select(TeacherInvite).where(
                TeacherInvite.centre_id == centre_id,
                TeacherInvite.email == normalise_email(email),
                TeacherInvite.status == InviteStatus.PENDING,
            )
        )
    ).one_or_none()


async def may_create_account(session: AsyncSession, settings: Settings, email: str) -> bool:
    """Whether this address may become a teacher: bootstrap list, or a pending invite."""
    if settings.is_teacher_email_allowed(email):
        return True
    centre = (
        await session.exec(select(Centre).where(Centre.slug == settings.centre_slug))
    ).one_or_none()
    return centre is not None and await pending_invite(session, centre.id, email) is not None


async def _accept(session: AsyncSession, invite: TeacherInvite | None) -> None:
    if invite is not None:
        invite.status = InviteStatus.ACCEPTED
        invite.accepted_at = utcnow()
        session.add(invite)


async def get_or_create_centre(session: AsyncSession, settings: Settings) -> Centre:
    """The one configured centre, created on first use."""
    statement = (
        pg_insert(Centre)
        .values(name=settings.centre_name, slug=settings.centre_slug)
        .on_conflict_do_nothing(index_elements=["slug"])
    )
    await session.exec(statement)

    centre = (await session.exec(select(Centre).where(Centre.slug == settings.centre_slug))).one()
    return centre


async def _relink_by_email(
    session: AsyncSession, claims: TeacherClaims, settings: Settings
) -> User | None:
    """An existing teacher whose Supabase account is new: the same person, signing in again.

    A Supabase account can be deleted and made again (or a project moved), which gives the
    same address a new Supabase id. Matching only on that id made a second, ordinary
    teacher with the same email — and stranded the owner on 23 Oct 2026. Supabase's Confirm
    email (which must stay on, root CLAUDE.md) proves the address, so:

    - an **active** teacher with it is re-linked to the new id;
    - a **removed** one comes back only with a pending invite, exactly as on their old
      account. Otherwise they are refused: recreating a Supabase account must not undo
      Remove, even for an address on the bootstrap allowlist.
    """
    centre = (
        await session.exec(select(Centre).where(Centre.slug == settings.centre_slug))
    ).one_or_none()
    if centre is None:
        return None
    rows = (
        await session.exec(
            select(User)
            .where(User.centre_id == centre.id, User.email == normalise_email(claims.email))
            # Oldest first: if a duplicate already exists, the original (the owner, when it
            # is theirs) is the account to keep.
            .order_by(User.created_at)  # type: ignore[arg-type]
        )
    ).all()
    if not rows:
        return None
    existing = next((u for u in rows if u.status == UserStatus.ACTIVE), None)
    invite = None
    if existing is None:
        invite = await pending_invite(session, centre.id, claims.email)
        if invite is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    "This account has been removed from the centre. "
                    "Ask the owner if that’s a mistake."
                ),
            )
        existing = rows[0]
        existing.status = UserStatus.ACTIVE
        await _accept(session, invite)
    previous = existing.supabase_user_id
    existing.supabase_user_id = claims.supabase_user_id
    session.add(existing)
    session.add(
        AuditLog(
            centre_id=existing.centre_id,
            actor_type=ActorType.USER,
            actor_id=existing.id,
            action="teacher.relinked" if invite is None else "teacher.reactivated",
            target_type="user",
            target_id=existing.id,
            payload={
                "email": existing.email,
                "previous_supabase_user_id": str(previous),
                **({"invite_id": str(invite.id)} if invite else {}),
            },
        )
    )
    await session.flush()
    return existing


async def provision_teacher(
    session: AsyncSession,
    claims: TeacherClaims,
    settings: Settings,
) -> tuple[User, bool]:
    """Return the teacher's users row, creating it on first sign-in.

    The bool is True when this call created the row, which the caller uses to decide
    whether to write an audit entry.
    """
    existing = (
        await session.exec(select(User).where(User.supabase_user_id == claims.supabase_user_id))
    ).one_or_none()
    if existing is not None:
        if existing.status == UserStatus.DISABLED:
            # Removed by the owner, and since invited again: the invite brings them back
            # with their history, rather than as a stranger with a second profile.
            invite = await pending_invite(session, existing.centre_id, existing.email)
            if invite is not None:
                existing.status = UserStatus.ACTIVE
                session.add(existing)
                await _accept(session, invite)
                session.add(
                    AuditLog(
                        centre_id=existing.centre_id,
                        actor_type=ActorType.USER,
                        actor_id=existing.id,
                        action="teacher.reactivated",
                        target_type="user",
                        target_id=existing.id,
                        payload={"email": existing.email, "invite_id": str(invite.id)},
                    )
                )
                await session.flush()
        return existing, False

    relinked = await _relink_by_email(session, claims, settings)
    if relinked is not None:
        return relinked, False

    if not await may_create_account(session, settings, claims.email):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=NOT_INVITED)

    centre = await get_or_create_centre(session, settings)

    # The first teacher into a centre owns it; everyone after is a teacher. Two
    # simultaneous first sign-ins could both see an empty centre and both become owner.
    # That is a harmless outcome — two owners of a centre they both belong to — and not
    # worth a lock in the sign-in path.
    teacher_count = (
        await session.exec(
            select(func.count()).select_from(User).where(User.centre_id == centre.id)
        )
    ).one()
    role = UserRole.OWNER if teacher_count == 0 else UserRole.TEACHER

    user = User(
        supabase_user_id=claims.supabase_user_id,
        centre_id=centre.id,
        email=normalise_email(claims.email),
        display_name=claims.display_name or claims.email.partition("@")[0],
        role=role,
    )
    session.add(user)

    try:
        await session.flush()
    except IntegrityError:
        # Another request provisioned the same teacher between the select and the
        # insert. Theirs is as good as ours.
        await session.rollback()
        user = (
            await session.exec(select(User).where(User.supabase_user_id == claims.supabase_user_id))
        ).one()
        return user, False

    invite = await pending_invite(session, centre.id, claims.email)
    await _accept(session, invite)
    session.add(
        AuditLog(
            centre_id=centre.id,
            actor_type=ActorType.USER,
            actor_id=user.id,
            action="teacher.provisioned",
            target_type="user",
            target_id=user.id,
            payload={
                "email": user.email,
                "role": UserRole(user.role).value,
                "invite_id": str(invite.id) if invite else None,
            },
        )
    )
    await session.flush()
    return user, True
