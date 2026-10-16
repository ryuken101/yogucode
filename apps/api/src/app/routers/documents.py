"""A student's own files.

**Every route here is `/me/...`, and that is a security decision rather than a style one.**
A route shaped `/students/{student_id}/documents` is a route that can be pointed at another
child, and the only thing standing between it and a leak would be a filter someone
remembers to write. `/me/documents` has no student id to get wrong: the subject comes from
the session cookie, so the wrong child is not expressible.

A teacher cannot read student work through this API at all. That arrives in Phase 5 with
submissions, because product-spec §2.2 is "co-piloting, not surveillance" — a teacher helps
with work a child has handed in, rather than browsing their drafts. `require_student` makes
a teacher principal a 403 here, which is the rare case where a teacher has *less* access
than a student.

**Nothing here is audited.** `audit_log` exists so that what a *teacher* did to a *child's*
record is reconstructable under the Privacy Act. A child editing their own file for ninety
minutes is neither, and an autosave every couple of seconds would bury the teacher actions
the table exists to surface. Creating and archiving a file are the child's own doing too.
This is a deliberate departure from the "every mutation is audited" rule the rest of the
API follows.
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import CurrentStudent, Principal
from app.db import get_session
from app.folders import STUDENT, get_folder, live_folder
from app.models import DocumentStatus, StudentDocument, TeacherDocument
from app.models.base import utcnow
from app.quiz import running_quiz_for
from app.scoping import get_owned_document, list_student_documents

router = APIRouter(prefix="/me/documents", tags=["documents"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]

MAX_TITLE_LENGTH = 80
# A Python file written by a ten-year-old. Generous enough never to be hit in a lesson,
# small enough that a runaway autosave cannot fill a 500MB free-tier disk. The column is
# unbounded `text`; the cap lives here, as it does for display_name and classes.name.
MAX_CONTENT_BYTES = 64 * 1024

# A file's type is its name, as in VS Code (Ken's decision, 11 Oct 2026): `.py` is Python,
# anything else is plain text that cannot be run. New files are Python, so children see
# — and get used to typing — the extension from their very first file.
DEFAULT_STEM = "untitled"
DEFAULT_EXTENSION = ".py"
DEFAULT_TITLE = DEFAULT_STEM + DEFAULT_EXTENSION
STARTER_CONTENT = '# Write your Python here, then press Run.\nprint("Hello!")\n'


class DocumentIn(BaseModel):
    title: str | None = Field(default=None, max_length=MAX_TITLE_LENGTH)
    content: str | None = Field(default=None, max_length=MAX_CONTENT_BYTES)
    # The folder to create it in; absent or null is the top level.
    folder_id: uuid.UUID | None = None


class DocumentPatch(BaseModel):
    """Every field optional — an absent field means "leave it alone"."""

    title: str | None = Field(default=None, min_length=1, max_length=MAX_TITLE_LENGTH)
    content: str | None = Field(default=None, max_length=MAX_CONTENT_BYTES)
    # Present means "move it": a folder id, or null for the top level.
    folder_id: uuid.UUID | None = None


class DocumentSummaryOut(BaseModel):
    """A row in the file list. Deliberately without `content`.

    The list is fetched whenever the editor loads, and a child with a term of work in six
    files should not be downloading all of it to render a sidebar.
    """

    id: uuid.UUID
    title: str
    folder_id: uuid.UUID | None
    status: DocumentStatus
    created_at: datetime
    updated_at: datetime

    @classmethod
    def build(cls, record: StudentDocument | TeacherDocument) -> "DocumentSummaryOut":
        return cls(
            id=record.id,
            title=record.title,
            folder_id=record.folder_id,
            status=record.status,
            created_at=record.created_at,
            updated_at=record.updated_at,
        )


class DocumentOut(DocumentSummaryOut):
    content: str

    @classmethod
    def build_full(cls, record: StudentDocument | TeacherDocument) -> "DocumentOut":
        return cls(**DocumentSummaryOut.build(record).model_dump(), content=record.content)


def default_title(existing: set[str]) -> str:
    """ "untitled.py", then "untitled2.py", and so on — never colliding with `existing`
    (the casefolded titles of the live files in the same folder)."""
    if DEFAULT_TITLE.casefold() not in existing:
        return DEFAULT_TITLE
    suffix = 2
    while f"{DEFAULT_STEM}{suffix}{DEFAULT_EXTENSION}".casefold() in existing:
        suffix += 1
    return f"{DEFAULT_STEM}{suffix}{DEFAULT_EXTENSION}"


def _duplicate_title() -> HTTPException:
    """The name is taken by another of this student's live files.

    Takes no arguments on purpose. Naming the file here would mean reading `record.title`
    after `session.rollback()`, which expires the instance — the attribute read then
    becomes lazy IO where asyncpg cannot service it and surfaces as `MissingGreenlet`
    instead of a 409. That bug was in this file once.

    Deliberately does not echo the attempted name back. The index is on `lower(title)`, so
    renaming to "SPIRAL" when "spiral" exists collides — and saying "you already have a
    file called SPIRAL" would assert something untrue about their files. The names are
    visible as tabs, so "that name" is enough to act on and is true in every case.
    """
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail="You already have a file with that name here",
    )


@router.get("", response_model=list[DocumentSummaryOut])
async def list_documents(
    principal: CurrentStudent, session: SessionDep, include_archived: bool = False
) -> list[DocumentSummaryOut]:
    records = await list_student_documents(session, principal, include_archived)
    return [DocumentSummaryOut.build(record) for record in records]


@router.post("", response_model=DocumentOut, status_code=status.HTTP_201_CREATED)
async def create_document(
    body: DocumentIn, principal: CurrentStudent, session: SessionDep
) -> DocumentOut:
    """Start a new file.

    Both fields are optional, because the common case is a child pressing "new file" with
    nothing in mind. An untitled file gets a number rather than a collision: the partial
    unique index would refuse a second "untitled.py", and a 409 in response to pressing a
    plus button is not an error a ten-year-old can act on.
    """
    return await create_file(session, principal, body)


async def create_file(session: AsyncSession, principal: Principal, body: DocumentIn) -> DocumentOut:
    """Make a file for the student `principal` is — the child, or a teacher acting on the
    child's files (`scoping.as_child`). The rules are the same either way."""
    folder_id = await live_folder(session, STUDENT, principal, body.folder_id)
    title = (body.title or "").strip() or await _next_default_title(session, principal, folder_id)
    record = StudentDocument(
        centre_id=principal.centre_id,
        student_id=principal.subject_id,
        folder_id=folder_id,
        title=title,
        content=body.content if body.content is not None else STARTER_CONTENT,
    )
    session.add(record)
    try:
        await session.commit()
    except IntegrityError as exc:
        # Only reachable when the title was supplied explicitly; the generated ones are
        # checked above. The database is the arbiter either way.
        await session.rollback()
        raise _duplicate_title() from exc
    await session.refresh(record)
    return DocumentOut.build_full(record)


async def _next_default_title(
    session: AsyncSession, principal: Principal, folder_id: uuid.UUID | None
) -> str:
    return default_title(
        {
            record.title.casefold()
            for record in await list_student_documents(session, principal, include_archived=False)
            if record.folder_id == folder_id
        }
    )


@router.get("/{document_id}", response_model=DocumentOut)
async def read_document(
    document_id: uuid.UUID, principal: CurrentStudent, session: SessionDep
) -> DocumentOut:
    return DocumentOut.build_full(await get_owned_document(session, principal, document_id))


@router.patch("/{document_id}", response_model=DocumentOut)
async def save_document(
    document_id: uuid.UUID,
    body: DocumentPatch,
    principal: CurrentStudent,
    session: SessionDep,
) -> DocumentOut:
    """Save. This is the autosave endpoint, so it is the busiest route in the product.

    A save that changes nothing writes nothing — `TimestampMixin` has `onupdate`, so
    touching the row would move `updated_at` and reshuffle the file list under a child who
    is only reading. The same reasoning as the no-op PATCH on classes and students.
    """
    record = await get_owned_document(session, principal, document_id)
    if await running_quiz_for(session, principal) is not None:
        # The quiz is the only thing a child can change while it runs (Ken's decision).
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="A quiz is running — finish it first"
        )

    return await change_file(session, principal, record, body)


async def change_file(
    session: AsyncSession, principal: Principal, record: StudentDocument, body: DocumentPatch
) -> DocumentOut:
    """Rename, move and/or save a file — a no-op writes nothing. Shared with the teacher's
    routes on a child's files, which never send content."""
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
        # Moving between folders (Ken's decision, 11 Oct 2026). Only into one of their own.
        target = await live_folder(session, STUDENT, principal, body.folder_id)
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
async def archive_document(
    document_id: uuid.UUID, principal: CurrentStudent, session: SessionDep
) -> DocumentOut:
    """Put a file away. It leaves the list; it stays in the database.

    Archive rather than delete, as everywhere else. A child who tidies up mid-term should
    not be able to destroy a term of their own work with one tap.
    """
    return await archive_file(session, await get_owned_document(session, principal, document_id))


async def archive_file(session: AsyncSession, record: StudentDocument) -> DocumentOut:
    if record.status != DocumentStatus.ARCHIVED:
        record.status = DocumentStatus.ARCHIVED
        session.add(record)
        await session.commit()
        await session.refresh(record)
    return DocumentOut.build_full(record)


@router.post("/{document_id}/restore", response_model=DocumentOut)
async def restore_document(
    document_id: uuid.UUID, principal: CurrentStudent, session: SessionDep
) -> DocumentOut:
    """Bring an archived file back.

    The partial unique index only covers live files, so a restore can collide with a file
    created since — hence the same 409 as a rename, rather than an IntegrityError.
    """
    record = await get_owned_document(session, principal, document_id)
    if record.status != DocumentStatus.ACTIVE:
        record.status = DocumentStatus.ACTIVE
        record.updated_at = utcnow()
        record.folder_id = await _still_live(session, principal, record.folder_id)
        session.add(record)
        try:
            await session.commit()
        except IntegrityError as exc:
            await session.rollback()
            raise _duplicate_title() from exc
        await session.refresh(record)
    return DocumentOut.build_full(record)


async def _still_live(
    session: AsyncSession, principal: CurrentStudent, folder_id: uuid.UUID | None
) -> uuid.UUID | None:
    """The file's folder if it still exists; the top level if it was deleted meanwhile."""
    if folder_id is None:
        return None
    folder = await get_folder(session, STUDENT, principal, folder_id)
    return folder.id if folder.status == DocumentStatus.ACTIVE else None
