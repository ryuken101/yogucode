"""A child's files, for a teacher — the Files app (16 Oct 2026).

A teacher opens a child's folder in Files and sees their work. Since 17 Oct 2026 (Ken)
they can also **organise** it: make folders and files, rename, move, copy a file in, and
delete (archive). They never change what a file says — that goes through Live's Help,
where the child's editor is locked while the teacher types (`app/live/hub.py`), so the
document `PATCH` here takes a name and a folder and nothing else. Every teacher at the
centre may — every teacher can open every class (`class_teachers` is organisation, not
permission).

The writes run the child's own rules (`app/folders.py`, `routers/documents.py`) as the
child (`scoping.as_child`), so a name clash, a folder in itself or another child's folder
is refused exactly as it would be for them. A child's quiz lock does not stop the teacher.

Tenancy: the child is resolved through `scoping.get_owned_student` first, so another
centre's child is a 404, and every query then filters on the centre **and** that child.
Students cannot reach these routes (`CurrentTeacher`).

Reading is not audited, like marking: it is the ordinary business of teaching. **Every
write is** (`student_file.*`, against the child), because it is a teacher changing a
child's work — what the audit log exists to make reconstructable.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlmodel.ext.asyncio.session import AsyncSession

from app.audit import audit_entry
from app.auth.principal import CurrentTeacher, Principal
from app.db import get_session
from app.folders import STUDENT, NoSlashes, create_folder, delete_folder, update_folder
from app.models import Student
from app.routers.documents import (
    MAX_TITLE_LENGTH,
    DocumentIn,
    DocumentOut,
    DocumentPatch,
    DocumentSummaryOut,
    archive_file,
    change_file,
    create_file,
)
from app.routers.folders import FolderDeletedOut, FolderIn, FolderOut, FolderPatch
from app.scoping import (
    as_child,
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


# --- organising (17 Oct 2026) -----------------------------------------------------------


class ChildDocumentPatch(BaseModel):
    """Rename and/or move a child's file. Never its content — see the module docstring."""

    title: Annotated[str | None, NoSlashes] = Field(
        default=None, min_length=1, max_length=MAX_TITLE_LENGTH
    )
    # Present means "move it": a folder id, or null for the top level.
    folder_id: uuid.UUID | None = None


async def _child(
    session: AsyncSession, principal: Principal, student_id: uuid.UUID
) -> tuple[Student, Principal]:
    student = await get_owned_student(session, principal, student_id)
    return student, as_child(principal, student)


def _audit(principal: Principal, student: Student, action: str, **payload: object):
    return audit_entry(principal, f"student_file.{action}", "student", student.id, **payload)


@router.post("/folders", response_model=FolderOut, status_code=status.HTTP_201_CREATED)
async def make_a_childs_folder(
    student_id: uuid.UUID, body: FolderIn, principal: CurrentTeacher, session: SessionDep
) -> FolderOut:
    student, child = await _child(session, principal, student_id)
    session.add(_audit(principal, student, "folder_created", name=body.name))
    return FolderOut.build(await create_folder(session, STUDENT, child, body.name, body.parent_id))


@router.patch("/folders/{folder_id}", response_model=FolderOut)
async def change_a_childs_folder(
    student_id: uuid.UUID,
    folder_id: uuid.UUID,
    body: FolderPatch,
    principal: CurrentTeacher,
    session: SessionDep,
) -> FolderOut:
    student, child = await _child(session, principal, student_id)
    fields = body.model_dump(exclude_unset=True)
    shown = body.model_dump(exclude_unset=True, mode="json")
    session.add(_audit(principal, student, "folder_changed", folder_id=str(folder_id), **shown))
    return FolderOut.build(await update_folder(session, STUDENT, child, folder_id, fields))


@router.post("/folders/{folder_id}/delete", response_model=FolderDeletedOut)
async def delete_a_childs_folder(
    student_id: uuid.UUID, folder_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> FolderDeletedOut:
    student, child = await _child(session, principal, student_id)
    session.add(_audit(principal, student, "folder_deleted", folder_id=str(folder_id)))
    return FolderDeletedOut(files_archived=await delete_folder(session, STUDENT, child, folder_id))


@router.post("/documents", response_model=DocumentOut, status_code=status.HTTP_201_CREATED)
async def make_a_childs_document(
    student_id: uuid.UUID, body: DocumentIn, principal: CurrentTeacher, session: SessionDep
) -> DocumentOut:
    """A new file in a child's files — empty, or a copy of one the teacher pastes in."""
    student, child = await _child(session, principal, student_id)
    session.add(
        _audit(principal, student, "created", title=body.title, copied=body.content is not None)
    )
    return await create_file(session, child, body)


@router.patch("/documents/{document_id}", response_model=DocumentOut)
async def change_a_childs_document(
    student_id: uuid.UUID,
    document_id: uuid.UUID,
    body: ChildDocumentPatch,
    principal: CurrentTeacher,
    session: SessionDep,
) -> DocumentOut:
    student, child = await _child(session, principal, student_id)
    record = await get_child_document(session, principal, student_id, document_id)
    fields = body.model_dump(exclude_unset=True, mode="json")
    session.add(_audit(principal, student, "changed", document_id=str(document_id), **fields))
    return await change_file(
        session, child, record, DocumentPatch(**body.model_dump(exclude_unset=True))
    )


@router.post("/documents/{document_id}/archive", response_model=DocumentOut)
async def archive_a_childs_document(
    student_id: uuid.UUID, document_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> DocumentOut:
    student, child = await _child(session, principal, student_id)
    record = await get_child_document(session, principal, student_id, document_id)
    if record.deleted_at is None:
        session.add(
            _audit(principal, student, "deleted", document_id=str(document_id), title=record.title)
        )
    # Into the child's own Trash, as if they had deleted it: they can restore it.
    return await archive_file(session, child, record)
