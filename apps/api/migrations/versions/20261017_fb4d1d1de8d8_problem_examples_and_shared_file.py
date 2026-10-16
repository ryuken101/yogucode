"""problem examples and shared file

Ken's decisions, 17 Oct 2026: a problem or part can carry sample runs for a child to
watch, and a problem's parts can share one file. Both default to what every existing row
already is — no examples, code per part — so nothing is backfilled. The table already has
row-level security.

Revision ID: fb4d1d1de8d8
Revises: e45893b1fe1a
Create Date: 2026-10-17 01:33:20.556228

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "fb4d1d1de8d8"
down_revision: str | Sequence[str] | None = "e45893b1fe1a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "items",
        sa.Column(
            "examples",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "items",
        sa.Column("shared_file", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("items", "shared_file")
    op.drop_column("items", "examples")
