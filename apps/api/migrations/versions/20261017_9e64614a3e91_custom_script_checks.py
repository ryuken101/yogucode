"""custom script checks

A third kind of test case (Ken's decision, 17 Oct 2026): `script`, the teacher's own
Python check, for checks that depend on values the child chose. The spec is JSONB already,
so only the `kind` CHECK constraint changes — by hand, since autogenerate does not see a
changed CHECK. The table already has row-level security.

Revision ID: 9e64614a3e91
Revises: fb4d1d1de8d8
Create Date: 2026-10-17 03:18:50.830093

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "9e64614a3e91"
down_revision: str | Sequence[str] | None = "fb4d1d1de8d8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_constraint(op.f("ck_test_cases_kind"), "test_cases", type_="check")
    op.create_check_constraint(
        op.f("ck_test_cases_kind"), "test_cases", "kind IN ('io', 'function', 'script')"
    )


def downgrade() -> None:
    """Downgrade schema. Custom checks go with the kind that allowed them."""
    op.execute("DELETE FROM test_cases WHERE kind = 'script'")
    op.drop_constraint(op.f("ck_test_cases_kind"), "test_cases", type_="check")
    op.create_check_constraint(
        op.f("ck_test_cases_kind"), "test_cases", "kind IN ('io', 'function')"
    )
