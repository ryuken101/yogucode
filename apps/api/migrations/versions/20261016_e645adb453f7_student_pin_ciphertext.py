"""student pin ciphertext

Show PIN (Ken's decision, 16 Oct 2026): an encrypted copy of each PIN beside its hash, so a
teacher can reveal it later. Nullable, with no backfill — a hash cannot be reversed, so a
PIN set before this stays unviewable until the teacher changes it. The table already has
row-level security.

Revision ID: e645adb453f7
Revises: 258a4e916260
Create Date: 2026-10-16 01:52:09.969129

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e645adb453f7"
down_revision: str | Sequence[str] | None = "258a4e916260"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "student_credentials",
        sa.Column("pin_ciphertext", sa.String(), nullable=True),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("student_credentials", "pin_ciphertext")
