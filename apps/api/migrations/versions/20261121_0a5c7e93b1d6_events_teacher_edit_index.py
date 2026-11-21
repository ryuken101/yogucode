"""events: partial index on teacher_edit by attempt

Skills asks "did a teacher help on this attempt?" for a whole class at once.

Revision ID: 0a5c7e93b1d6
Revises: f19b0c6d2a84
Create Date: 2026-11-21 15:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0a5c7e93b1d6"
down_revision: str | Sequence[str] | None = "f19b0c6d2a84"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_index(
        "ix_events_teacher_edit",
        "events",
        ["attempt_id"],
        unique=False,
        postgresql_where=sa.text("type = 'teacher_edit'"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        "ix_events_teacher_edit",
        table_name="events",
        postgresql_where=sa.text("type = 'teacher_edit'"),
    )
