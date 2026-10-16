"""compare checks

A fourth kind of test case (Ken's decision, 17 Oct 2026): `compare`, "matches my solution".
It runs the reference solution with the child's own values put into it and compares the
output, so a teacher gets correct checks for student-chosen data without writing code. Only
the `kind` CHECK constraint changes, by hand. The table already has row-level security.

Revision ID: 52468d22b6f4
Revises: 9e64614a3e91
Create Date: 2026-10-17 04:34:00

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "52468d22b6f4"
down_revision: str | Sequence[str] | None = "9e64614a3e91"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_constraint(op.f("ck_test_cases_kind"), "test_cases", type_="check")
    op.create_check_constraint(
        op.f("ck_test_cases_kind"),
        "test_cases",
        "kind IN ('io', 'function', 'script', 'compare')",
    )


def downgrade() -> None:
    """Downgrade schema. Compare checks go with the kind that allowed them."""
    op.execute("DELETE FROM test_cases WHERE kind = 'compare'")
    op.drop_constraint(op.f("ck_test_cases_kind"), "test_cases", type_="check")
    op.create_check_constraint(
        op.f("ck_test_cases_kind"), "test_cases", "kind IN ('io', 'function', 'script')"
    )
