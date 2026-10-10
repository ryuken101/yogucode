"""Folders — the logic shared by a child's My files and a teacher's My code.

The two owners differ only in which tables and which owner column they use, so the rules
live here once and `routers/folders.py` mounts them twice. Every lookup filters on the
centre **and** the owner (`student_id` / `user_id` = the signed-in subject), exactly as
their files do: another child's or teacher's folder is a 404, never a 403.

Folder counts are small (a child has a handful), so the tree is read whole whenever a
move or a delete needs it, rather than walked with recursive SQL.
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import Principal
from app.models import (
    DocumentStatus,
    StudentDocument,
    StudentFolder,
    TeacherDocument,
    TeacherFolder,
)
from app.models.base import utcnow

MAX_FOLDER_NAME = 80


@dataclass(frozen=True)
class Owner:
    """Which tables, and which column says whose they are."""

    folder: Any  # type[StudentFolder] | type[TeacherFolder]
    document: Any  # type[StudentDocument] | type[TeacherDocument]
    column: str


STUDENT = Owner(StudentFolder, StudentDocument, "student_id")
TEACHER = Owner(TeacherFolder, TeacherDocument, "user_id")


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="folder not found")


def name_taken() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail="There’s already a folder with that name here",
    )


def clean_name(raw: str) -> str:
    name = " ".join(raw.split())
    if not name or len(name) > MAX_FOLDER_NAME or "/" in name:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Folder names can’t be blank or contain “/”",
        )
    return name


def _mine(owner: Owner, model: Any, principal: Principal) -> list[Any]:
    return [
        model.centre_id == principal.centre_id,
        getattr(model, owner.column) == principal.subject_id,
    ]


async def all_folders(session: AsyncSession, owner: Owner, principal: Principal) -> Sequence[Any]:
    """Every folder this owner has, archived ones included — for walking the tree."""
    return (
        await session.exec(select(owner.folder).where(*_mine(owner, owner.folder, principal)))
    ).all()


async def live_folders(session: AsyncSession, owner: Owner, principal: Principal) -> list[Any]:
    rows = await all_folders(session, owner, principal)
    return sorted(
        (f for f in rows if f.status == DocumentStatus.ACTIVE), key=lambda f: f.name.casefold()
    )


async def get_folder(
    session: AsyncSession, owner: Owner, principal: Principal, folder_id: uuid.UUID
) -> Any:
    """One of this owner's own folders, or 404. Archived ones are found too."""
    found = (
        await session.exec(
            select(owner.folder).where(
                owner.folder.id == folder_id, *_mine(owner, owner.folder, principal)
            )
        )
    ).one_or_none()
    if found is None:
        raise _not_found()
    return found


async def live_folder(
    session: AsyncSession, owner: Owner, principal: Principal, folder_id: uuid.UUID | None
) -> uuid.UUID | None:
    """Check a folder you are putting something into: yours, and not deleted. None = top."""
    if folder_id is None:
        return None
    folder = await get_folder(session, owner, principal, folder_id)
    if folder.status != DocumentStatus.ACTIVE:
        raise _not_found()
    return folder.id


def subtree(folders: Sequence[Any], root: uuid.UUID) -> set[uuid.UUID]:
    """The folder and everything inside it, at any depth."""
    children: dict[uuid.UUID | None, list[uuid.UUID]] = {}
    for f in folders:
        children.setdefault(f.parent_id, []).append(f.id)
    found, stack = {root}, [root]
    while stack:
        for child in children.get(stack.pop(), []):
            if child not in found:
                found.add(child)
                stack.append(child)
    return found


async def create_folder(
    session: AsyncSession,
    owner: Owner,
    principal: Principal,
    name: str,
    parent_id: uuid.UUID | None,
) -> Any:
    parent = await live_folder(session, owner, principal, parent_id)
    record = owner.folder(
        centre_id=principal.centre_id,
        parent_id=parent,
        name=clean_name(name),
        **{owner.column: principal.subject_id},
    )
    session.add(record)
    await _commit(session, name_taken)
    await session.refresh(record)
    return record


async def update_folder(
    session: AsyncSession,
    owner: Owner,
    principal: Principal,
    folder_id: uuid.UUID,
    fields: dict[str, Any],
) -> Any:
    """Rename (`name`) and/or move (`parent_id`, None for the top level)."""
    record = await get_folder(session, owner, principal, folder_id)
    if "name" in fields and fields["name"] is not None:
        record.name = clean_name(fields["name"])
    if "parent_id" in fields:
        target = await live_folder(session, owner, principal, fields["parent_id"])
        # A folder cannot go inside itself or anything inside it: that would cut the
        # branch off the tree, and its files would vanish from the explorer.
        if target is not None and target in subtree(
            await all_folders(session, owner, principal), record.id
        ):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="A folder can’t go inside itself",
            )
        record.parent_id = target
    session.add(record)
    await _commit(session, name_taken)
    await session.refresh(record)
    return record


async def delete_folder(
    session: AsyncSession, owner: Owner, principal: Principal, folder_id: uuid.UUID
) -> int:
    """Archive a folder, everything inside it, and every file in them. Returns files moved.

    Archive, not delete: a child tidying up must never destroy their work, and the files
    can be brought back.
    """
    record = await get_folder(session, owner, principal, folder_id)
    ids = subtree(await all_folders(session, owner, principal), record.id)
    now = utcnow()
    for folder in await all_folders(session, owner, principal):
        if folder.id in ids and folder.status == DocumentStatus.ACTIVE:
            folder.status = DocumentStatus.ARCHIVED
            folder.updated_at = now
            session.add(folder)
    files = (
        await session.exec(
            select(owner.document).where(
                owner.document.folder_id.in_(ids),
                owner.document.status == DocumentStatus.ACTIVE,
                *_mine(owner, owner.document, principal),
            )
        )
    ).all()
    for file in files:
        file.status = DocumentStatus.ARCHIVED
        session.add(file)
    await session.commit()
    return len(files)


async def _commit(session: AsyncSession, on_clash) -> None:
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise on_clash() from exc
