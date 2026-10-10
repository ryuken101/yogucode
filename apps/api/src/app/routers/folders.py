"""Folder routes for My files (`/me/folders`, children) and My code (`/teacher/folders`).

The same routes mounted twice over `app.folders`, which holds the rules. A child's folder
changes are refused while a quiz runs, like their file saves — during a quiz, the quiz is
the only thing they can change (Ken's decision, Phase 7).
"""

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import Principal, require_student, require_teacher
from app.db import get_session
from app.folders import (
    MAX_FOLDER_NAME,
    STUDENT,
    TEACHER,
    Owner,
    create_folder,
    delete_folder,
    live_folders,
    update_folder,
)
from app.quiz import running_quiz_for

SessionDep = Annotated[AsyncSession, Depends(get_session)]


class FolderIn(BaseModel):
    name: str = Field(min_length=1, max_length=MAX_FOLDER_NAME)
    parent_id: uuid.UUID | None = None


class FolderPatch(BaseModel):
    """Rename and/or move. An absent field is left alone; `parent_id: null` is the top."""

    name: str | None = Field(default=None, min_length=1, max_length=MAX_FOLDER_NAME)
    parent_id: uuid.UUID | None = None


class FolderOut(BaseModel):
    id: uuid.UUID
    name: str
    parent_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def build(cls, record: Any) -> "FolderOut":
        return cls(
            id=record.id,
            name=record.name,
            parent_id=record.parent_id,
            created_at=record.created_at,
            updated_at=record.updated_at,
        )


class FolderDeletedOut(BaseModel):
    files_archived: int


def _router(prefix: str, owner: Owner, who: Any, *, quiz_guard: bool) -> APIRouter:
    router = APIRouter(prefix=prefix, tags=["folders"])
    Who = Annotated[Principal, Depends(who)]

    async def guard(session: AsyncSession, principal: Principal) -> None:
        if quiz_guard and await running_quiz_for(session, principal) is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="A quiz is running — finish it first"
            )

    @router.get("", response_model=list[FolderOut])
    async def list_folders(principal: Who, session: SessionDep) -> list[FolderOut]:
        return [FolderOut.build(f) for f in await live_folders(session, owner, principal)]

    @router.post("", response_model=FolderOut, status_code=status.HTTP_201_CREATED)
    async def new_folder(body: FolderIn, principal: Who, session: SessionDep) -> FolderOut:
        await guard(session, principal)
        return FolderOut.build(
            await create_folder(session, owner, principal, body.name, body.parent_id)
        )

    @router.patch("/{folder_id}", response_model=FolderOut)
    async def change_folder(
        folder_id: uuid.UUID, body: FolderPatch, principal: Who, session: SessionDep
    ) -> FolderOut:
        await guard(session, principal)
        fields = body.model_dump(exclude_unset=True)
        return FolderOut.build(await update_folder(session, owner, principal, folder_id, fields))

    @router.post("/{folder_id}/delete", response_model=FolderDeletedOut)
    async def remove_folder(
        folder_id: uuid.UUID, principal: Who, session: SessionDep
    ) -> FolderDeletedOut:
        await guard(session, principal)
        return FolderDeletedOut(
            files_archived=await delete_folder(session, owner, principal, folder_id)
        )

    return router


student_router = _router("/me/folders", STUDENT, require_student, quiz_guard=True)
teacher_router = _router("/teacher/folders", TEACHER, require_teacher, quiz_guard=False)
