"""Class CRUD, scoped to the signed-in teacher's centre.

Every lookup goes through `app.scoping`, which applies the `centre_id` filter. Nothing in
this module builds its own query against `classes` — see the module docstring there for
why that rule exists.

Archive rather than delete, throughout. A class holds a term of enrolments and, later,
attempts and events; deleting one would vaporise the history Phase 8 reads.
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlmodel import select, update
from sqlmodel.ext.asyncio.session import AsyncSession

from app.audit import audit_entry
from app.auth.principal import CurrentTeacher, Principal
from app.db import get_session
from app.models import (
    AuditLog,
    Class,
    ClassJoinCode,
    ClassStatus,
    ClassTeacher,
    ClassTeacherRole,
)
from app.models.base import utcnow
from app.scoping import get_owned_class, list_owned_classes

router = APIRouter(prefix="/classes", tags=["classes"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]


class ClassIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    term_label: str | None = Field(default=None, max_length=60)


class ClassPatch(BaseModel):
    """Every field optional — an absent field means "leave it alone"."""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    term_label: str | None = Field(default=None, max_length=60)


class ClassOut(BaseModel):
    id: uuid.UUID
    name: str
    term_label: str | None
    status: ClassStatus
    created_at: datetime
    updated_at: datetime

    @classmethod
    def build(cls, record: Class) -> "ClassOut":
        return cls(
            id=record.id,
            name=record.name,
            term_label=record.term_label,
            status=record.status,
            created_at=record.created_at,
            updated_at=record.updated_at,
        )


def _audit(principal: Principal, action: str, class_id: uuid.UUID, **payload: object) -> AuditLog:
    return audit_entry(principal, action, "class", class_id, **payload)


@router.post("", response_model=ClassOut, status_code=status.HTTP_201_CREATED)
async def create_class(body: ClassIn, principal: CurrentTeacher, session: SessionDep) -> ClassOut:
    record = Class(
        centre_id=principal.centre_id,
        name=body.name.strip(),
        term_label=body.term_label.strip() if body.term_label else None,
    )
    session.add(record)
    await session.flush()

    # The creator leads the class until someone says otherwise. Recording it now means
    # "whose class is this" is answerable without a backfill when an assignment UI lands.
    session.add(
        ClassTeacher(class_id=record.id, user_id=principal.subject_id, role=ClassTeacherRole.LEAD)
    )
    session.add(_audit(principal, "class.created", record.id, name=record.name))
    await session.commit()
    await session.refresh(record)
    return ClassOut.build(record)


@router.get("", response_model=list[ClassOut])
async def list_classes(
    principal: CurrentTeacher, session: SessionDep, include_archived: bool = False
) -> list[ClassOut]:
    records = await list_owned_classes(session, principal, include_archived)
    return [ClassOut.build(record) for record in records]


@router.get("/{class_id}", response_model=ClassOut)
async def read_class(
    class_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> ClassOut:
    return ClassOut.build(await get_owned_class(session, principal, class_id))


@router.patch("/{class_id}", response_model=ClassOut)
async def update_class(
    class_id: uuid.UUID, body: ClassPatch, principal: CurrentTeacher, session: SessionDep
) -> ClassOut:
    record = await get_owned_class(session, principal, class_id)

    changed: dict[str, object] = {}
    # exclude_unset distinguishes "term_label": null (clear it) from an absent field
    # (leave it), which a plain `if body.term_label` cannot.
    fields = body.model_dump(exclude_unset=True)
    if "name" in fields and fields["name"] is not None:
        record.name = body.name.strip()  # type: ignore[union-attr]
        changed["name"] = record.name
    if "term_label" in fields:
        record.term_label = body.term_label.strip() if body.term_label else None
        changed["term_label"] = record.term_label

    if changed:
        session.add(record)
        session.add(_audit(principal, "class.renamed", record.id, **changed))
        await session.commit()
        await session.refresh(record)
    return ClassOut.build(record)


@router.post("/{class_id}/archive", response_model=ClassOut)
async def archive_class(
    class_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> ClassOut:
    """Close a class: hide it from the default list and revoke its live join codes.

    Enrolments are left untouched. They are the record of who was actually in the class
    this term, which is exactly what Phase 8 mastery reads — withdrawing them on archive
    would overwrite history to tidy up a status field.
    """
    record = await get_owned_class(session, principal, class_id)
    record.status = ClassStatus.ARCHIVED
    session.add(record)

    # A code for a finished class should not still open a door.
    now = utcnow()
    live_codes = (
        await session.exec(
            select(ClassJoinCode).where(
                ClassJoinCode.class_id == record.id,
                ClassJoinCode.revoked_at.is_(None),  # type: ignore[union-attr]
            )
        )
    ).all()
    if live_codes:
        await session.exec(
            update(ClassJoinCode)
            .where(
                ClassJoinCode.class_id == record.id,
                ClassJoinCode.revoked_at.is_(None),  # type: ignore[union-attr]
            )
            .values(revoked_at=now)
        )

    session.add(_audit(principal, "class.archived", record.id, join_codes_revoked=len(live_codes)))
    await session.commit()
    await session.refresh(record)
    return ClassOut.build(record)


@router.post("/{class_id}/unarchive", response_model=ClassOut)
async def unarchive_class(
    class_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> ClassOut:
    """Undo an archive.

    Revoked join codes stay revoked — reviving a code nobody expects to work again is a
    worse surprise than issuing a fresh one.
    """
    record = await get_owned_class(session, principal, class_id)
    record.status = ClassStatus.ACTIVE
    session.add(record)
    session.add(_audit(principal, "class.unarchived", record.id))
    await session.commit()
    await session.refresh(record)
    return ClassOut.build(record)
