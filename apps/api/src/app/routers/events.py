"""Event ingestion: the browser's batched process trace (see `models/events.py`).

`/me/events` like every student route, so the subject comes from the cookie. Every attempt
and document a batch names is resolved through `app.scoping` — the same three-part filter
as reading it — so a child cannot write events into another child's trace by naming their
attempt. One foreign id refuses the whole batch with the same 404 as reading it would.

Idempotent by construction: the browser mints the ids and the insert skips any it has seen,
so a batch resent after a dropped connection is harmless. That is what Phase 6's offline
buffer relies on.
"""

import json
import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import CurrentStudent
from app.db import get_session
from app.models import Event, EventType
from app.models.base import utcnow
from app.scoping import get_own_attempt, get_owned_document

router = APIRouter(prefix="/me/events", tags=["events"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]

MAX_BATCH = 500
# The same cap as a file: an edit that pastes a whole program is the largest legitimate
# payload there is.
MAX_PAYLOAD_BYTES = 64 * 1024


class EventIn(BaseModel):
    id: uuid.UUID
    attempt_id: uuid.UUID | None = None
    document_id: uuid.UUID | None = None
    editor_session_id: uuid.UUID
    seq: int = Field(ge=0)
    type: EventType
    payload: dict[str, Any] = Field(default_factory=dict)
    client_ts: datetime

    @model_validator(mode="after")
    def _one_target(self) -> "EventIn":
        if (self.attempt_id is None) == (self.document_id is None):
            raise ValueError("an event belongs to exactly one attempt or one file")
        return self

    @field_validator("payload")
    @classmethod
    def _small(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(json.dumps(value)) > MAX_PAYLOAD_BYTES:
            raise ValueError("event payload too large")
        return value


class EventBatchIn(BaseModel):
    events: list[EventIn] = Field(max_length=MAX_BATCH)


class EventBatchOut(BaseModel):
    received: int


@router.post("", response_model=EventBatchOut, status_code=status.HTTP_202_ACCEPTED)
async def record_events(
    body: EventBatchIn, principal: CurrentStudent, session: SessionDep
) -> EventBatchOut:
    for attempt_id in {e.attempt_id for e in body.events if e.attempt_id}:
        await get_own_attempt(session, principal, attempt_id)
    for document_id in {e.document_id for e in body.events if e.document_id}:
        await get_owned_document(session, principal, document_id)

    if body.events:
        now = utcnow()
        await session.exec(
            pg_insert(Event)  # type: ignore[call-overload]
            .values(
                [
                    {
                        "id": e.id,
                        "centre_id": principal.centre_id,
                        "student_id": principal.subject_id,
                        "attempt_id": e.attempt_id,
                        "document_id": e.document_id,
                        "editor_session_id": e.editor_session_id,
                        "seq": e.seq,
                        "type": e.type.value,
                        "payload": e.payload,
                        "client_ts": e.client_ts,
                        "server_ts": now,
                    }
                    for e in body.events
                ]
            )
            .on_conflict_do_nothing(index_elements=["id"])
        )
        await session.commit()
    return EventBatchOut(received=len(body.events))
