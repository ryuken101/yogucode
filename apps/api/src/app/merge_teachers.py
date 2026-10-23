"""Merge one teacher account into another: for the duplicate a recreated Supabase account
used to make (found 23 Oct 2026; `auth/provisioning.py` now re-links by email instead).

    uv run python -m app.merge_teachers --keep <user id> --from <user id>          # dry run
    uv run python -m app.merge_teachers --keep <user id> --from <user id> --apply

Everything the duplicate made or is attached to moves to the account being kept, and the
kept account takes over the duplicate's Supabase login (the one in use now). The duplicate
is then disabled, never deleted: audit rows still name it. One transaction: it all happens
or none of it does. Without `--apply` it runs, prints what it would change, and rolls back.

Aim it with `DATABASE_URL`. Never run it against production without checking the ids
there first: production's ids are not dev's.
"""

import argparse
import asyncio
import uuid

from sqlalchemy import text
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import ActorType, AuditLog, User, UserRole, UserStatus

# Every column that points at users.id, except the two handled specially below
# (class_teachers, whose key includes the user, and desktop_layouts, one per user).
REPOINT = [
    ("teacher_invites", "invited_by"),
    ("items", "created_by"),
    ("class_join_codes", "created_by"),
    ("sets", "created_by"),
    ("assignments", "created_by"),
    ("student_credentials", "pin_set_by"),
    ("marks", "marker_id"),
    ("assignment_notes", "marker_id"),
    ("feedback_snippets", "created_by"),
    ("teacher_folders", "user_id"),
    ("teacher_documents", "user_id"),
]
NIL = "00000000-0000-0000-0000-000000000000"


async def _run(session: AsyncSession, sql: str, **params) -> int:
    result = await session.exec(text(sql), params=params)  # type: ignore[call-overload]
    return result.rowcount or 0


async def merge_teachers(session: AsyncSession, keep_id: uuid.UUID, from_id: uuid.UUID) -> dict:
    """Move `from_id`'s everything onto `keep_id`. Returns rows changed per table. Does not
    commit: the caller decides."""
    keep = await session.get(User, keep_id)
    dup = await session.get(User, from_id)
    if keep is None or dup is None:
        raise SystemExit("Both ids must be teachers that exist.")
    if keep.id == dup.id or keep.centre_id != dup.centre_id:
        raise SystemExit("Two different teachers at the same centre, please.")
    ids = {"keep": keep.id, "dup": dup.id}
    counts: dict[str, int] = {}

    # Both on a class: one row stays, Lead if either was.
    counts["class_teachers (both on)"] = await _run(
        session,
        """UPDATE class_teachers k SET role = 'lead'
           FROM class_teachers d
           WHERE k.user_id = :keep AND d.user_id = :dup AND d.class_id = k.class_id
             AND d.role = 'lead'""",
        **ids,
    )
    await _run(
        session,
        """DELETE FROM class_teachers d USING class_teachers k
           WHERE d.user_id = :dup AND k.user_id = :keep AND k.class_id = d.class_id""",
        **ids,
    )
    counts["class_teachers"] = await _run(
        session, "UPDATE class_teachers SET user_id = :keep WHERE user_id = :dup", **ids
    )

    # Names are unique per folder per teacher: a clash gets "(merged)" rather than failing.
    counts["teacher_folders renamed"] = await _run(
        session,
        f"""UPDATE teacher_folders d SET name = d.name || ' (merged)'
            FROM teacher_folders k
            WHERE d.user_id = :dup AND k.user_id = :keep
              AND d.status = 'active' AND k.status = 'active'
              AND coalesce(d.parent_id, '{NIL}'::uuid) = coalesce(k.parent_id, '{NIL}'::uuid)
              AND lower(d.name) = lower(k.name)""",
        **ids,
    )
    counts["teacher_documents renamed"] = await _run(
        session,
        f"""UPDATE teacher_documents d
            SET title = regexp_replace(d.title, '(\\.[^.]*)?$', ' (merged)\\1')
            FROM teacher_documents k
            WHERE d.user_id = :dup AND k.user_id = :keep
              AND d.status = 'active' AND k.status = 'active'
              AND coalesce(d.folder_id, '{NIL}'::uuid) = coalesce(k.folder_id, '{NIL}'::uuid)
              AND lower(d.title) = lower(k.title)""",
        **ids,
    )

    for table, column in REPOINT:
        counts[f"{table}.{column}"] = await _run(
            session, f"UPDATE {table} SET {column} = :keep WHERE {column} = :dup", **ids
        )
    counts["desktop_layouts (dropped)"] = await _run(
        session, "DELETE FROM desktop_layouts WHERE user_id = :dup", **ids
    )

    # The updates above went straight to the database: forget any copies loaded earlier.
    session.expire_all()
    await session.refresh(keep)
    await session.refresh(dup)

    # The login in use is the duplicate's: the kept account takes it over. The id is unique,
    # so the duplicate lets go of it first.
    login = dup.supabase_user_id
    dup.supabase_user_id = uuid.uuid4()
    dup.status = UserStatus.DISABLED
    session.add(dup)
    await session.flush()
    keep.supabase_user_id = login
    if dup.role == UserRole.OWNER:
        keep.role = UserRole.OWNER
    session.add(keep)
    session.add(
        AuditLog(
            centre_id=keep.centre_id,
            actor_type=ActorType.SYSTEM,
            actor_id=None,
            action="teacher.merged",
            target_type="user",
            target_id=keep.id,
            payload={"merged_from": str(dup.id), "email": keep.email, "rows": counts},
        )
    )
    await session.flush()
    return counts


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--keep", type=uuid.UUID, required=True)
    parser.add_argument("--from", dest="from_", type=uuid.UUID, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    from app.db import async_session_factory, engine

    async with async_session_factory() as session:
        counts = await merge_teachers(session, args.keep, args.from_)
        for name, n in counts.items():
            if n:
                print(f"{n:6}  {name}")
        if args.apply:
            await session.commit()
            print("Merged.")
        else:
            await session.rollback()
            print("Dry run: nothing changed. Add --apply to do it.")
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
