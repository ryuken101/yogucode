"""attempt saved to a file

A lesson or homework problem can also be saved to a file in the child's Files (Ken's
decision, 17 Oct 2026): the first Save asks where, and later saves keep the file up to
date. Nullable, no backfill. The table already has row-level security.

Revision ID: b2b4e2e0d011
Revises: 52468d22b6f4
Create Date: 2026-10-17 22:23:02.235503

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b2b4e2e0d011"
down_revision: str | Sequence[str] | None = "52468d22b6f4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("attempts", sa.Column("document_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_attempts_document_id_student_documents"),
        "attempts",
        "student_documents",
        ["document_id"],
        ["id"],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(
        op.f("fk_attempts_document_id_student_documents"), "attempts", type_="foreignkey"
    )
    op.drop_column("attempts", "document_id")
