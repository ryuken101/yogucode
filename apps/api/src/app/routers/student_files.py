"""A child's files, read by a teacher — the Files app (16 Oct 2026).

Read-only. A teacher opens a child's folder in Files and sees their work; changing it goes
through Live's Help, where the child's editor is locked while the teacher types
(`app/live/hub.py`). Every teacher at the centre may look — every teacher can open every
class (`class_teachers` is organisation, not permission).

Tenancy: the child is resolved through `scoping.get_owned_student` first, so another
centre's child is a 404, and every query then filters on the centre **and** that child.
Students cannot reach these routes (`CurrentTeacher`).

Not audited, like marking: reading submitted work is the ordinary business of teaching.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import CurrentTeacher
from app.db import get_session
from app.routers.documents import DocumentOut, DocumentSummaryOut
from app.routers.folders import FolderOut
from app.scoping import (
    get_child_document,
    get_owned_student,
    list_child_documents,
    list_child_folders,
)

router = APIRouter(prefix="/students/{student_id}", tags=["student files"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]


@router.get("/folders", response_model=list[FolderOut])
async def list_a_childs_folders(
    student_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> list[FolderOut]:
    await get_owned_student(session, principal, student_id)
    return [FolderOut.build(f) for f in await list_child_folders(session, principal, student_id)]


@router.get("/documents", response_model=list[DocumentSummaryOut])
async def list_a_childs_documents(
    student_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> list[DocumentSummaryOut]:
    await get_owned_student(session, principal, student_id)
    records = await list_child_documents(session, principal, student_id)
    return [DocumentSummaryOut.build(r) for r in records]


@router.get("/documents/{document_id}", response_model=DocumentOut)
async def read_a_childs_document(
    student_id: uuid.UUID, document_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> DocumentOut:
    await get_owned_student(session, principal, student_id)
    return DocumentOut.build_full(
        await get_child_document(session, principal, student_id, document_id)
    )
