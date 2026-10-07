"""teacher edit events

Revision ID: 70b930db46fb
Revises: f04a3ee61cb0
Create Date: 2026-10-08 01:28:36.390695

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "70b930db46fb"
down_revision: str | Sequence[str] | None = "f04a3ee61cb0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


OLD_TYPES = "'edit', 'run', 'check', 'error', 'paste', 'hint', 'submit'"
NEW_TYPES = OLD_TYPES + ", 'teacher_edit'"


def upgrade() -> None:
    """Allow `teacher_edit` events (live view help).

    Written by hand: autogenerate does not see a changed CHECK constraint.
    """
    op.drop_constraint(op.f("ck_events_type"), "events", type_="check")
    op.create_check_constraint(op.f("ck_events_type"), "events", f"type IN ({NEW_TYPES})")


def downgrade() -> None:
    # Rows a teacher wrote would violate the old constraint; they go with it.
    op.execute("DELETE FROM events WHERE type = 'teacher_edit'")
    op.drop_constraint(op.f("ck_events_type"), "events", type_="check")
    op.create_check_constraint(op.f("ck_events_type"), "events", f"type IN ({OLD_TYPES})")
