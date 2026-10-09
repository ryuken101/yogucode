"""Who may create a teacher account (Ken's decision, 10 Oct 2026).

Teachers sign up with an email and a password, but only at an address the centre's owner
has invited from the Teachers page. Anyone can create an account in Supabase — the anon
key is public — so the gate is here: provisioning a `users` row needs a pending invite (or
the address in `TEACHER_EMAIL_ALLOWLIST`, which is now only the bootstrap owner list).

An invite is `pending` until that address first signs in, then `accepted`; the owner can
`revoke` a pending one. Rows are kept either way — who was let in, by whom, is history.
"""

import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import CheckConstraint, DateTime, Index, String, text
from sqlmodel import Field

from app.models.base import TimestampMixin, new_uuid


class InviteStatus(StrEnum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    REVOKED = "revoked"


class TeacherInvite(TimestampMixin, table=True):
    __tablename__ = "teacher_invites"
    __table_args__ = (
        CheckConstraint("status IN ('pending', 'accepted', 'revoked')", name="status"),
        # Emails are stored lowercased, so a plain column index is case-insensitive in
        # effect. One open invite per address per centre.
        Index(
            "uq_teacher_invites_pending_email",
            "centre_id",
            "email",
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
    )

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    email: str = Field(index=True)
    invited_by: uuid.UUID = Field(foreign_key="users.id")
    status: InviteStatus = Field(default=InviteStatus.PENDING, sa_type=String)
    accepted_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True))
