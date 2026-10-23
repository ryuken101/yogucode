"""A teacher's own files — "My code" (Ken's decision, 10 Oct 2026).

Where a teacher writes and runs Python to demonstrate on the projector. The routes mirror a
child's `/me/documents` (`routers/documents.py`) and reuse its request and response shapes,
caps and starter content, so the web app's editor treats both the same.

**Private to the teacher.** Every lookup goes through `scoping.get_own_teacher_document` /
`list_own_teacher_documents`, which filter on the centre *and* the signed-in user, so
another teacher's file is a 404. Students cannot reach these routes (`CurrentTeacher`).

Not audited, for the same reason a child's own files are not: `audit_log` records what is
done to children's records, and a teacher's scratch files are neither.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, status
from sqlalchemy.exc import IntegrityError
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import CurrentTeacher, Principal
from app.db import get_session
from app.folders import TEACHER, live_folder
from app.models import TeacherDocument
from app.models.base import utcnow
from app.routers.documents import (
    STARTER_CONTENT,
    DocumentIn,
    DocumentOut,
    DocumentPatch,
    DocumentSummaryOut,
    _duplicate_title,
    default_title,
)
from app.scoping import get_own_teacher_document, list_own_teacher_documents
from app.trash import put_in, restore

router = APIRouter(prefix="/teacher/documents", tags=["teacher documents"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]


@router.get("", response_model=list[DocumentSummaryOut])
async def list_teacher_documents(
    principal: CurrentTeacher, session: SessionDep, include_archived: bool = False
) -> list[DocumentSummaryOut]:
    records = await list_own_teacher_documents(session, principal, include_archived)
    return [DocumentSummaryOut.build(record) for record in records]


async def _next_default_title(
    session: AsyncSession, principal: Principal, folder_id: uuid.UUID | None
) -> str:
    return default_title(
        {
            record.title.casefold()
            for record in await list_own_teacher_documents(
                session, principal, include_archived=False
            )
            if record.folder_id == folder_id
        }
    )


@router.post("", response_model=DocumentOut, status_code=status.HTTP_201_CREATED)
async def create_teacher_document(
    body: DocumentIn, principal: CurrentTeacher, session: SessionDep
) -> DocumentOut:
    folder_id = await live_folder(session, TEACHER, principal, body.folder_id)
    title = (body.title or "").strip() or await _next_default_title(session, principal, folder_id)
    record = TeacherDocument(
        centre_id=principal.centre_id,
        user_id=principal.subject_id,
        folder_id=folder_id,
        title=title,
        content=body.content if body.content is not None else STARTER_CONTENT,
    )
    session.add(record)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise _duplicate_title() from exc
    await session.refresh(record)
    return DocumentOut.build_full(record)


@router.get("/{document_id}", response_model=DocumentOut)
async def read_teacher_document(
    document_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> DocumentOut:
    return DocumentOut.build_full(await get_own_teacher_document(session, principal, document_id))


@router.patch("/{document_id}", response_model=DocumentOut)
async def save_teacher_document(
    document_id: uuid.UUID,
    body: DocumentPatch,
    principal: CurrentTeacher,
    session: SessionDep,
) -> DocumentOut:
    """Save (autosave and rename). A save that changes nothing writes nothing."""
    record = await get_own_teacher_document(session, principal, document_id)
    fields = body.model_dump(exclude_unset=True)
    changed = False
    if "title" in fields and fields["title"] is not None:
        title = body.title.strip()  # type: ignore[union-attr]
        if title and title != record.title:
            record.title = title
            changed = True
    if "content" in fields and fields["content"] is not None and body.content != record.content:
        record.content = body.content
        changed = True
    if "folder_id" in fields:
        target = await live_folder(session, TEACHER, principal, body.folder_id)
        if target != record.folder_id:
            record.folder_id = target
            changed = True

    if changed:
        session.add(record)
        try:
            await session.commit()
        except IntegrityError as exc:
            await session.rollback()
            raise _duplicate_title() from exc
        await session.refresh(record)
    return DocumentOut.build_full(record)


@router.post("/{document_id}/archive", response_model=DocumentOut)
async def archive_teacher_document(
    document_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> DocumentOut:
    """Delete a file: into the teacher's Trash for 30 days (`app/trash.py`)."""
    record = await get_own_teacher_document(session, principal, document_id)
    if record.deleted_at is None:
        put_in(record, principal.subject_id, utcnow())
        session.add(record)
        await session.commit()
        await session.refresh(record)
    return DocumentOut.build_full(record)


@router.post("/{document_id}/restore", response_model=DocumentOut)
async def restore_teacher_document(
    document_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> DocumentOut:
    """Out of the Trash, to its folder if that is still there (`app/trash.py`)."""
    record = await get_own_teacher_document(session, principal, document_id)
    if record.deleted_at is not None:
        record = await restore(session, principal, "file", record.id)
    return DocumentOut.build_full(record)
