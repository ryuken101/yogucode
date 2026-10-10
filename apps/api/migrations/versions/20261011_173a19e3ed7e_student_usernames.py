"""student usernames

Permanent student accounts (Ken's decision, 11 Oct 2026): children sign in with a
username and their PIN. Existing students get a username suggested from their name.

Revision ID: 173a19e3ed7e
Revises: eba5db480965
Create Date: 2026-10-11 01:50:24.363264

"""

import re
import unicodedata
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "173a19e3ed7e"
down_revision: str | Sequence[str] | None = "eba5db480965"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Self-contained on purpose: a migration must not import app code that may change later.
def _base(display_name: str) -> str:
    ascii_name = (
        unicodedata.normalize("NFKD", display_name).encode("ascii", "ignore").decode().lower()
    )
    words = re.findall(r"[a-z0-9]+", ascii_name)
    if not words:
        return "student"
    base = f"{words[0]}.{words[-1][0]}" if len(words) > 1 else words[0]
    base = base[:26].strip(".")
    return base if len(base) >= 2 else "student"


def upgrade() -> None:
    """Give every existing student a username, then require one.

    Existing PINs are untouched, so nobody needs a new slip: children keep their PIN and
    sign in with the username shown on the class page.
    """
    op.add_column("students", sa.Column("username", sa.String(), nullable=True))

    bind = op.get_bind()
    taken: set[str] = set()
    rows = bind.execute(sa.text("SELECT id, display_name FROM students ORDER BY id")).all()
    for student_id, display_name in rows:
        base = _base(display_name)
        username, number = base, 2
        while username in taken:
            username = f"{base}{number}"
            number += 1
        taken.add(username)
        bind.execute(
            sa.text("UPDATE students SET username = :u WHERE id = :id"),
            {"u": username, "id": student_id},
        )

    op.alter_column("students", "username", nullable=False)
    op.create_check_constraint(
        op.f("ck_students_username"), "students", "username ~ '^[a-z0-9.]{2,30}$'"
    )
    op.create_index(
        "uq_students_username", "students", [sa.literal_column("lower(username)")], unique=True
    )


def downgrade() -> None:
    op.drop_index("uq_students_username", table_name="students")
    op.drop_constraint(op.f("ck_students_username"), "students", type_="check")
    op.drop_column("students", "username")
