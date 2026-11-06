"""quiz_sittings and assignments.hand_in_at

Revision ID: c4f1a7d2e9b3
Revises: 86a9fc4a80a6
Create Date: 2026-11-06 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c4f1a7d2e9b3"
down_revision: str | Sequence[str] | None = "86a9fc4a80a6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("assignments", sa.Column("hand_in_at", sa.DateTime(timezone=True), nullable=True))
    op.create_table(
        "quiz_sittings",
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
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("centre_id", sa.Uuid(), nullable=False),
        sa.Column("assignment_id", sa.Uuid(), nullable=False),
        sa.Column("student_id", sa.Uuid(), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("away_count", sa.Integer(), nullable=False),
        sa.Column("away_seconds", sa.Integer(), nullable=False),
        sa.Column("left_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["assignment_id"],
            ["assignments.id"],
            name=op.f("fk_quiz_sittings_assignment_id_assignments"),
        ),
        sa.ForeignKeyConstraint(
            ["centre_id"], ["centres.id"], name=op.f("fk_quiz_sittings_centre_id_centres")
        ),
        sa.ForeignKeyConstraint(
            ["student_id"], ["students.id"], name=op.f("fk_quiz_sittings_student_id_students")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_quiz_sittings")),
        sa.UniqueConstraint(
            "assignment_id", "student_id", name="uq_quiz_sittings_assignment_student"
        ),
    )
    op.create_index(
        op.f("ix_quiz_sittings_assignment_id"), "quiz_sittings", ["assignment_id"], unique=False
    )
    op.create_index(
        op.f("ix_quiz_sittings_centre_id"), "quiz_sittings", ["centre_id"], unique=False
    )
    op.create_index(
        op.f("ix_quiz_sittings_student_id"), "quiz_sittings", ["student_id"], unique=False
    )
    op.execute("ALTER TABLE public.quiz_sittings ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.drop_table("quiz_sittings")
    op.drop_column("assignments", "hand_in_at")
