"""desktop layouts

A teacher's saved desktop: which app windows are open and where (16 Oct 2026). One row per
teacher, the layout as JSONB validated by `routers/desktop.py`. Row-level security is on
with no policies, like every table (see cce4cbf9b9f0).

Revision ID: e45893b1fe1a
Revises: e645adb453f7
Create Date: 2026-10-16 04:12:17.892970

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "e45893b1fe1a"
down_revision: str | Sequence[str] | None = "e645adb453f7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "desktop_layouts",
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("centre_id", sa.Uuid(), nullable=False),
        sa.Column("layout", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(
            ["centre_id"], ["centres.id"], name=op.f("fk_desktop_layouts_centre_id_centres")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_desktop_layouts_user_id_users")
        ),
        sa.PrimaryKeyConstraint("user_id", name=op.f("pk_desktop_layouts")),
    )
    op.create_index(
        op.f("ix_desktop_layouts_centre_id"), "desktop_layouts", ["centre_id"], unique=False
    )
    op.execute("ALTER TABLE public.desktop_layouts ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_desktop_layouts_centre_id"), table_name="desktop_layouts")
    op.drop_table("desktop_layouts")
