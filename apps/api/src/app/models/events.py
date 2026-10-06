"""The process trace: what a child did in the editor, not just what they ended with.

Spec §5.4: process data is append-only and **cannot be backfilled**, which is why this
arrives in Phase 5 rather than waiting for the replay that will read it (Phase 7), the
mastery that will weigh it (Phase 8) or the stuck signals that will watch it (Phase 10).
Every week without it is a week of homework nobody can ever replay.

One row per thing that happened: an edit (as a diff, never a snapshot — a 90-minute
session of snapshots is megabytes), a run, a check and its result, a Python error, a
paste, a hint, a hand-in. Recorded for problem attempts **and** for My files, by Ken's
decision; exactly one of `attempt_id` / `document_id` says which.

**The id is minted by the browser** (UUIDv7, see `base.py`), and inserts are
`ON CONFLICT DO NOTHING`. A batch that is retried after a dropped connection therefore
lands once. That is the whole of what Phase 6's offline buffer needs from the server: it
can resend anything it is unsure of.

`seq` orders events within one `editor_session_id` (one page load). `client_ts` is the
child's clock, which may be wrong; `server_ts` is ours. Replay orders by session and seq,
not by either clock.

Not audited, for the reason `routers/documents.py` gives: a child's own keystrokes are
neither a teacher's action nor a change to their record.
"""

import uuid
from datetime import datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, Index, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel

from app.models.base import utcnow


class EventType(StrEnum):
    EDIT = "edit"
    RUN = "run"
    CHECK = "check"
    ERROR = "error"
    PASTE = "paste"
    HINT = "hint"
    SUBMIT = "submit"


class Event(SQLModel, table=True):
    __tablename__ = "events"
    __table_args__ = (
        CheckConstraint(
            "type IN ('edit', 'run', 'check', 'error', 'paste', 'hint', 'submit')", name="type"
        ),
        CheckConstraint("(attempt_id IS NULL) <> (document_id IS NULL)", name="one_target"),
        Index("ix_events_attempt_seq", "attempt_id", "editor_session_id", "seq"),
        Index("ix_events_document_seq", "document_id", "editor_session_id", "seq"),
    )

    # No default: the browser mints it, which is what makes a retried batch idempotent.
    id: uuid.UUID = Field(primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    student_id: uuid.UUID = Field(foreign_key="students.id", index=True)
    attempt_id: uuid.UUID | None = Field(default=None, foreign_key="attempts.id")
    document_id: uuid.UUID | None = Field(default=None, foreign_key="student_documents.id")
    editor_session_id: uuid.UUID
    seq: int
    type: EventType = Field(sa_type=String)
    payload: dict[str, Any] = Field(default_factory=dict, sa_type=JSONB)
    client_ts: datetime = Field(sa_type=DateTime(timezone=True))
    server_ts: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
