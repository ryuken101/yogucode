"""The problem bank's folders: teachers' own groups, shared across the centre.

Teacher only, and every lookup goes through the centre (`scoping`), so another centre's
folder is a 404. Deleting a folder is the Trash's job (`app/trash.py`, kind `problem_folder`);
its problems are not touched.

**A problem and its other versions are one thing here.** While a new version is being
written, the old one and the draft are separate rows, both on the bank's list. Adding or
removing either covers the family, so publishing neither brings a removed problem back nor
loses an added one. `copy_folder_memberships` does the same when a new version is made.
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlmodel import col, delete, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.audit import audit_entry
from app.auth.principal import CurrentTeacher, Principal
from app.db import get_session
from app.models import Item, ProblemFolder, ProblemFolderItem
from app.models.base import utcnow
from app.scoping import get_owned_item, get_owned_problem_folder

router = APIRouter(prefix="/problem-folders", tags=["problem-folders"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]

MAX_NAME = 60
MAX_ITEMS_AT_ONCE = 500


def _clean_name(value: str) -> str:
    value = " ".join(value.split())
    if not value:
        raise ValueError("A folder needs a name")
    return value


class ProblemFolderIn(BaseModel):
    name: str = Field(min_length=1, max_length=MAX_NAME)

    _name = field_validator("name")(_clean_name)


class ProblemFolderOut(BaseModel):
    id: uuid.UUID
    name: str
    updated_at: datetime


class ProblemFolderItemsIn(BaseModel):
    item_ids: list[uuid.UUID] = Field(min_length=1, max_length=MAX_ITEMS_AT_ONCE)


def _out(folder: ProblemFolder) -> ProblemFolderOut:
    return ProblemFolderOut(id=folder.id, name=folder.name, updated_at=folder.updated_at)


def _name_taken() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT, detail="There’s already a folder with that name."
    )


async def _version_family(session: AsyncSession, item: Item) -> list[uuid.UUID]:
    """This problem and every version before and after it."""
    family = {item.id}
    current = item
    for _ in range(50):  # a chain longer than this is a bug, not a history
        if current.supersedes_id is None or current.supersedes_id in family:
            break
        older = await session.get(Item, current.supersedes_id)
        if older is None or older.centre_id != item.centre_id:
            break
        family.add(older.id)
        current = older
    frontier = [item.id]
    for _ in range(50):
        if not frontier:
            break
        newer = (
            await session.exec(
                select(Item.id).where(
                    col(Item.supersedes_id).in_(frontier), Item.centre_id == item.centre_id
                )
            )
        ).all()
        frontier = [i for i in newer if i not in family]
        family.update(frontier)
    return list(family)


async def copy_folder_memberships(
    session: AsyncSession, centre_id: uuid.UUID, from_item: uuid.UUID, to_item: uuid.UUID
) -> None:
    """A new version joins its predecessor's folders. The caller commits."""
    folders = (
        await session.exec(
            select(ProblemFolderItem.folder_id).where(
                ProblemFolderItem.item_id == from_item, ProblemFolderItem.centre_id == centre_id
            )
        )
    ).all()
    if folders:
        await session.exec(
            pg_insert(ProblemFolderItem)
            .values([{"folder_id": f, "item_id": to_item, "centre_id": centre_id} for f in folders])
            .on_conflict_do_nothing()
        )


async def folder_ids_by_item(
    session: AsyncSession, principal: Principal, item_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[uuid.UUID]]:
    """The live folders each of these problems is in, for the bank's list."""
    rows = (
        await session.exec(
            select(ProblemFolderItem.item_id, ProblemFolderItem.folder_id)
            .join(ProblemFolder, col(ProblemFolder.id) == ProblemFolderItem.folder_id)
            .where(
                col(ProblemFolderItem.item_id).in_(item_ids),
                ProblemFolderItem.centre_id == principal.centre_id,
                col(ProblemFolder.deleted_at).is_(None),
            )
        )
    ).all()
    found: dict[uuid.UUID, list[uuid.UUID]] = {}
    for item_id, folder_id in rows:
        found.setdefault(item_id, []).append(folder_id)
    return found


@router.get("", response_model=list[ProblemFolderOut])
async def list_folders(principal: CurrentTeacher, session: SessionDep) -> list[ProblemFolderOut]:
    rows = (
        await session.exec(
            select(ProblemFolder)
            .where(
                ProblemFolder.centre_id == principal.centre_id,
                col(ProblemFolder.deleted_at).is_(None),
            )
            .order_by(col(ProblemFolder.name))
        )
    ).all()
    return [_out(row) for row in rows]


@router.post("", response_model=ProblemFolderOut, status_code=status.HTTP_201_CREATED)
async def create_folder(
    body: ProblemFolderIn, principal: CurrentTeacher, session: SessionDep
) -> ProblemFolderOut:
    folder = ProblemFolder(
        centre_id=principal.centre_id, name=body.name, created_by=principal.subject_id
    )
    session.add(folder)
    try:
        await session.flush()
    except IntegrityError as exc:
        await session.rollback()
        raise _name_taken() from exc
    session.add(
        audit_entry(
            principal, "problem_folder.created", "problem_folder", folder.id, name=body.name
        )
    )
    await session.commit()
    await session.refresh(folder)
    return _out(folder)


@router.patch("/{folder_id}", response_model=ProblemFolderOut)
async def rename_folder(
    folder_id: uuid.UUID, body: ProblemFolderIn, principal: CurrentTeacher, session: SessionDep
) -> ProblemFolderOut:
    folder = await get_owned_problem_folder(session, principal, folder_id)
    folder.name = body.name
    folder.updated_at = utcnow()
    session.add(folder)
    session.add(
        audit_entry(
            principal, "problem_folder.renamed", "problem_folder", folder.id, name=body.name
        )
    )
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise _name_taken() from exc
    await session.refresh(folder)
    return _out(folder)


@router.post("/{folder_id}/items", status_code=status.HTTP_204_NO_CONTENT)
async def add_items(
    folder_id: uuid.UUID, body: ProblemFolderItemsIn, principal: CurrentTeacher, session: SessionDep
) -> None:
    """Put problems in a folder. Adding one that is already there does nothing."""
    folder = await get_owned_problem_folder(session, principal, folder_id)
    members: set[uuid.UUID] = set()
    for item_id in set(body.item_ids):
        item = await get_owned_item(session, principal, item_id)
        members.update(await _version_family(session, item))
    await session.exec(
        pg_insert(ProblemFolderItem)
        .values(
            [
                {"folder_id": folder.id, "item_id": member, "centre_id": principal.centre_id}
                for member in members
            ]
        )
        .on_conflict_do_nothing()
    )
    session.add(
        audit_entry(
            principal, "problem_folder.items_added", "problem_folder", folder.id, count=len(members)
        )
    )
    await session.commit()


@router.delete("/{folder_id}/items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_item(
    folder_id: uuid.UUID, item_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> None:
    """Take a problem out of a folder. The problem itself is not touched."""
    folder = await get_owned_problem_folder(session, principal, folder_id)
    item = await get_owned_item(session, principal, item_id)
    family = await _version_family(session, item)
    await session.exec(
        delete(ProblemFolderItem).where(
            col(ProblemFolderItem.folder_id) == folder.id,
            col(ProblemFolderItem.item_id).in_(family),
        )
    )
    session.add(
        audit_entry(
            principal, "problem_folder.item_removed", "problem_folder", folder.id, item=str(item.id)
        )
    )
    await session.commit()
