"""First-sign-in provisioning for teachers.

One academy, one centre. The centre named in config is created by whoever signs in
first, and every allowlisted teacher after that joins the same one. A second teacher
signing in must never produce a second tenant — they would silently be unable to see
each other's classes, and merging afterwards means moving rows across the tenancy
boundary this whole design exists to keep intact.

Both inserts here race with themselves: two teachers can sign in for the first time at
the same moment, and one teacher's browser can fire two requests. Both are resolved by
letting the database decide — the unique constraints on `centres.slug` and
`users.supabase_user_id` are the arbiter — rather than by checking first and hoping.
"""

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlmodel import func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.supabase_jwt import TeacherClaims
from app.config import Settings
from app.models import ActorType, AuditLog, Centre, User, UserRole


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
        return existing, False

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
        email=claims.email,
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

    session.add(
        AuditLog(
            centre_id=centre.id,
            actor_type=ActorType.USER,
            actor_id=user.id,
            action="teacher.provisioned",
            target_type="user",
            target_id=user.id,
            payload={"email": user.email, "role": str(user.role)},
        )
    )
    await session.flush()
    return user, True
