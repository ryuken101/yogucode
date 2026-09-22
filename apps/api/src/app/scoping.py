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
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import Principal
from app.models import Centre, Class, ClassStatus


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
