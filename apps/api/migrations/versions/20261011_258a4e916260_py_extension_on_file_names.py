"""py extension on file names

A file's type is its name, as in VS Code (Ken's decision, 11 Oct 2026): `.py` is Python,
anything else is plain text. Every existing file — children's and teachers' — was Python,
so each one without `.py` gets it added ("spiral" → "spiral.py").

Names are unique per folder among live files, so where "spiral.py" already sits next to
"spiral", the renamed one becomes "spiral (2).py" rather than failing. Archived files are
outside that rule and simply get ".py".

The downgrade leaves names alone: a ".py" a child typed and one this added look the same,
and stripping both would rename work the child named themselves.

Revision ID: 258a4e916260
Revises: 173a19e3ed7e
Create Date: 2026-10-11 02:31:59.665723
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "258a4e916260"
down_revision: str | Sequence[str] | None = "173a19e3ed7e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLES = [("student_documents", "student_id"), ("teacher_documents", "user_id")]


def upgrade() -> None:
    bind = op.get_bind()
    for table, owner in TABLES:
        rows = bind.execute(
            sa.text(f"SELECT id, {owner}, folder_id, title, status FROM {table} ORDER BY id")
        ).all()
        # Live names per (owner, folder), lower-cased, as the unique index sees them.
        taken: dict[tuple, set[str]] = {}
        for _id, who, folder, title, status in rows:
            if status == "active":
                taken.setdefault((who, folder), set()).add(title.lower())

        for row_id, who, folder, title, status in rows:
            if title.lower().endswith(".py"):
                continue
            names = taken.setdefault((who, folder), set())
            renamed = f"{title}.py"
            number = 2
            while status == "active" and renamed.lower() in names:
                renamed = f"{title} ({number}).py"
                number += 1
            if status == "active":
                names.discard(title.lower())
                names.add(renamed.lower())
            bind.execute(
                sa.text(f"UPDATE {table} SET title = :title WHERE id = :id"),
                {"title": renamed, "id": row_id},
            )


def downgrade() -> None:
    """Names stay as they are — see the module docstring."""
