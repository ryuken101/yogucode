"""problem folders

The problem bank's own groups (7 Nov 2026), shared across a centre. Row-level security is on
with no policies, like every table (see cce4cbf9b9f0).

Revision ID: d7e2b94c1a60
Revises: c4f1a7d2e9b3
Create Date: 2026-11-07 09:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d7e2b94c1a60"
down_revision: str | Sequence[str] | None = "c4f1a7d2e9b3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "problem_folders",
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
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_by", sa.Uuid(), nullable=True),
        sa.Column("status_before_delete", sa.String(), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("centre_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.CheckConstraint(
            "status IN ('active', 'archived')", name=op.f("ck_problem_folders_status")
        ),
        sa.ForeignKeyConstraint(
            ["centre_id"], ["centres.id"], name=op.f("fk_problem_folders_centre_id_centres")
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_problem_folders_created_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_problem_folders")),
    )
    op.create_index(
        op.f("ix_problem_folders_centre_id"), "problem_folders", ["centre_id"], unique=False
    )
    op.create_index(
        op.f("ix_problem_folders_deleted_at"), "problem_folders", ["deleted_at"], unique=False
    )
    op.create_index(
        "uq_problem_folders_live_name",
        "problem_folders",
        ["centre_id", sa.text("lower(name)")],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )
    op.create_table(
        "problem_folder_items",
        sa.Column("folder_id", sa.Uuid(), nullable=False),
        sa.Column("item_id", sa.Uuid(), nullable=False),
        sa.Column("centre_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["centre_id"], ["centres.id"], name=op.f("fk_problem_folder_items_centre_id_centres")
        ),
        sa.ForeignKeyConstraint(
            ["folder_id"],
            ["problem_folders.id"],
            name=op.f("fk_problem_folder_items_folder_id_problem_folders"),
        ),
        sa.ForeignKeyConstraint(
            ["item_id"], ["items.id"], name=op.f("fk_problem_folder_items_item_id_items")
        ),
        sa.PrimaryKeyConstraint("folder_id", "item_id", name=op.f("pk_problem_folder_items")),
    )
    op.create_index(
        op.f("ix_problem_folder_items_centre_id"),
        "problem_folder_items",
        ["centre_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_problem_folder_items_item_id"), "problem_folder_items", ["item_id"], unique=False
    )
    op.execute("ALTER TABLE public.problem_folders ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE public.problem_folder_items ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.drop_table("problem_folder_items")
    op.drop_table("problem_folders")
