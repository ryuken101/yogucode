"""The Trash, over HTTP. The rules, and who may do what, are in `app/trash.py`.

Teachers: list, trash, restore, and delete for good. Children: list and restore their own
files and folders — never delete for good. A child's or teacher's file or folder goes into
the Trash through its own route's Delete (`routers/documents.py`, `routers/folders.py`,
`routers/teacher_documents.py`), which already knew whose it was.
"""

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlmodel.ext.asyncio.session import AsyncSession

from app import trash
from app.auth.principal import CurrentStudent, CurrentTeacher
from app.db import get_session

router = APIRouter(tags=["trash"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]

TeacherKind = Literal[
    "class", "student", "problem", "course", "unit", "lesson", "homework", "file", "folder"
]
ChildKind = Literal["file", "folder"]


class TrashEntryOut(BaseModel):
    kind: TeacherKind
    id: uuid.UUID
    name: str
    # E.g. "Quiz · Year 4–6 Python" for homework and quizzes.
    detail: str | None
    deleted_at: datetime
    deleted_by: str | None
    # When the purge job deletes it for good.
    purge_after: datetime
    can_purge: bool
    # Deleting a class or a child for good asks for their name to be typed.
    needs_name: bool


class PurgeIn(BaseModel):
    confirm_name: str | None = Field(default=None, max_length=200)


def _out(entries: list[trash.Entry]) -> list[TrashEntryOut]:
    return [TrashEntryOut.model_validate(e, from_attributes=True) for e in entries]


@router.get("/trash", response_model=list[TrashEntryOut])
async def list_trash(principal: CurrentTeacher, session: SessionDep) -> list[TrashEntryOut]:
    return _out(await trash.list_trash(session, principal))


@router.post("/trash/{kind}/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def put_in_trash(
    kind: TeacherKind, item_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> None:
    await trash.trash(session, principal, kind, item_id)


@router.post("/trash/{kind}/{item_id}/restore", status_code=status.HTTP_204_NO_CONTENT)
async def restore(
    kind: TeacherKind, item_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> None:
    await trash.restore(session, principal, kind, item_id)


@router.post("/trash/{kind}/{item_id}/purge", status_code=status.HTTP_204_NO_CONTENT)
async def purge(
    kind: TeacherKind,
    item_id: uuid.UUID,
    body: PurgeIn,
    principal: CurrentTeacher,
    session: SessionDep,
) -> None:
    await trash.purge(session, principal, kind, item_id, body.confirm_name)


@router.get("/me/trash", response_model=list[TrashEntryOut])
async def list_my_trash(principal: CurrentStudent, session: SessionDep) -> list[TrashEntryOut]:
    return _out(await trash.list_trash(session, principal))


@router.post("/me/trash/{kind}/{item_id}/restore", status_code=status.HTTP_204_NO_CONTENT)
async def restore_mine(
    kind: ChildKind, item_id: uuid.UUID, principal: CurrentStudent, session: SessionDep
) -> None:
    await trash.restore(session, principal, kind, item_id)
