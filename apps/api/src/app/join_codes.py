"""Class join codes — the short string a teacher reads out so a child can find their class.

A code belongs to a class for the life of the class. `create_class` mints one, so a class
always has a code; rotating mints a new one and revokes the old in the same breath, and
archiving the class revokes it (step 4). There is deliberately **no standalone revoke**: a
class nobody can join is not a state a teacher should be able to reach by accident, and
"the code leaked" is answered by rotating, not by closing the door and walking away.

The alphabet is the interesting part:

- **No vowels.** A generated code cannot then accidentally spell a word, which for a
  product used by nine-year-olds is not a hypothetical problem.
- **No `0 O 1 I L`.** The code's whole job is to survive being read aloud to a room and
  copied off a whiteboard. Characters that are ambiguous spoken or written are the ones
  that generate support questions mid-lesson.

That leaves 28 characters; six of them is about 480 million codes.
"""

import secrets
import uuid

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlmodel import select, update
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import Principal
from app.models import Class, ClassJoinCode, ClassStatus
from app.models.base import new_uuid, utcnow

JOIN_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789"
JOIN_CODE_LENGTH = 6

# A collision needs a second draw, not a failure. At 28^6 this effectively never runs,
# but "effectively never" is not "never" and the alternative is a 500 in front of a class.
_MINT_ATTEMPTS = 5


def new_code() -> str:
    """A fresh code. `secrets`, not `random` — this is a credential-shaped thing."""
    return "".join(secrets.choice(JOIN_CODE_ALPHABET) for _ in range(JOIN_CODE_LENGTH))


async def mint_code(
    session: AsyncSession, principal: Principal, class_id: uuid.UUID
) -> ClassJoinCode:
    """Insert a new live code for a class.

    `code` is globally unique, so a collision is resolved by letting the database refuse
    the row and drawing again — the `on_conflict_do_nothing` precedent from
    `provisioning.get_or_create_centre`. An `IntegrityError` would be the obvious
    alternative and is the wrong one here: it poisons the surrounding transaction, and
    minting happens *inside* `create_class`, alongside the class and its teacher link.

    The caller owns the transaction; nothing here commits.
    """
    for _ in range(_MINT_ATTEMPTS):
        record = ClassJoinCode(
            id=new_uuid(),
            class_id=class_id,
            code=new_code(),
            created_by=principal.subject_id,
        )
        result = await session.exec(
            pg_insert(ClassJoinCode)
            .values(
                id=record.id,
                class_id=record.class_id,
                code=record.code,
                created_by=record.created_by,
                created_at=record.created_at,
            )
            .on_conflict_do_nothing(index_elements=["code"])
        )
        if result.rowcount:
            return record
    raise RuntimeError(  # pragma: no cover — 5 collisions in a 480M space
        "could not mint a unique join code"
    )


async def rotate_code(
    session: AsyncSession, principal: Principal, class_id: uuid.UUID
) -> ClassJoinCode:
    """Revoke every live code for a class and mint one, atomically.

    Rotation is the remedy for a leaked code, so the old one has to stop working *now*
    rather than at some expiry — which is also why `expires_at` stays null throughout.
    """
    await session.exec(
        update(ClassJoinCode)
        .where(
            ClassJoinCode.class_id == class_id,  # type: ignore[arg-type]
            ClassJoinCode.revoked_at.is_(None),  # type: ignore[union-attr]
        )
        .values(revoked_at=utcnow())
    )
    return await mint_code(session, principal, class_id)


async def resolve_code(session: AsyncSession, code: str) -> Class | None:
    """The active class a live code belongs to, or None.

    **This is the one read in the codebase that is deliberately not centre-scoped.** Every
    other read of a centre-owned table goes through `app.scoping`, which applies
    `Principal.centre_id`; this one cannot, because the caller is a child at `/join` who
    has not signed in and has no principal to scope by. Knowing the code is what
    authorises the read, and the route built on it returns display names and nothing else.

    An archived class is not joinable — `archive_class` revokes its codes anyway, so the
    status check is belt and braces for a code that somehow outlived its class.
    """
    normalised = code.strip().upper()
    if not normalised:
        return None
    return (
        await session.exec(
            select(Class)
            .join(ClassJoinCode, ClassJoinCode.class_id == Class.id)  # type: ignore[arg-type]
            .where(
                ClassJoinCode.code == normalised,
                ClassJoinCode.revoked_at.is_(None),  # type: ignore[union-attr]
                Class.status == ClassStatus.ACTIVE,
            )
        )
    ).one_or_none()
