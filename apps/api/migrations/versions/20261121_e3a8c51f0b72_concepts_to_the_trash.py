"""concepts: deleted_at, deleted_by, status_before_delete

A teacher deletes a concept tag, with its sub-skills, to the Trash (Ken, 21 Nov 2026).

Revision ID: e3a8c51f0b72
Revises: d7e2b94c1a60
Create Date: 2026-11-21 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e3a8c51f0b72"
down_revision: str | Sequence[str] | None = "d7e2b94c1a60"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("concepts", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("concepts", sa.Column("deleted_by", sa.Uuid(), nullable=True))
    op.add_column(
        "concepts",
        sa.Column("status_before_delete", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
    )
    op.create_index(op.f("ix_concepts_deleted_at"), "concepts", ["deleted_at"], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_concepts_deleted_at"), table_name="concepts")
    op.drop_column("concepts", "status_before_delete")
    op.drop_column("concepts", "deleted_by")
    op.drop_column("concepts", "deleted_at")
