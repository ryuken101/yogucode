"""A teacher's desktop layout — which app windows are open, and where (16 Oct 2026).

The web app is a desktop of app windows (Ken's decision): a dock, windows that open full
screen or are dragged and snapped. A teacher's arrangement is saved to their account so it
follows them to whichever centre laptop they sign in on. One row per teacher, replaced
whole on each save; the shape is validated by `routers/desktop.py`, not the database.

Students have no row: their windows are fixed full screen, so there is nothing to keep.
"""

import uuid
from typing import Any

from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field

from app.models.base import TimestampMixin


class DesktopLayout(TimestampMixin, table=True):
    __tablename__ = "desktop_layouts"

    user_id: uuid.UUID = Field(foreign_key="users.id", primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    layout: dict[str, Any] = Field(default_factory=dict, sa_type=JSONB)
