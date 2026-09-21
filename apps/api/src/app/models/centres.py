"""Centres — the tenancy root.

Every authorisation check in the platform resolves to a centre_id. It exists in an MVP
serving one class because adding a tenancy column later means backfilling every table
and re-auditing every query (a second centre is the expected way to grow).
"""

import uuid

from sqlmodel import Field

from app.models.base import TimestampMixin, new_uuid


class Centre(TimestampMixin, table=True):
    __tablename__ = "centres"

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    name: str
    slug: str = Field(unique=True, index=True)
    region: str = Field(default="ap-southeast-2")
