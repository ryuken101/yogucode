"""classes: revisit_slipping, revisit_stuck, revisit_stale

Which signs flag a concept for a child to revisit, per class (Ken, 21 Nov 2026).

Revision ID: f19b0c6d2a84
Revises: e3a8c51f0b72
Create Date: 2026-11-21 11:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f19b0c6d2a84"
down_revision: str | Sequence[str] | None = "e3a8c51f0b72"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

COLUMNS = ("revisit_slipping", "revisit_stuck", "revisit_stale")


def upgrade() -> None:
    """Upgrade schema."""
    for name in COLUMNS:
        op.add_column(
            "classes",
            sa.Column(name, sa.Boolean(), server_default=sa.text("true"), nullable=False),
        )


def downgrade() -> None:
    """Downgrade schema."""
    for name in reversed(COLUMNS):
        op.drop_column("classes", name)
