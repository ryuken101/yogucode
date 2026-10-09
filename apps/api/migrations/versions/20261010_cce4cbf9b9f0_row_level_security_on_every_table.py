"""row level security on every table

Revision ID: cce4cbf9b9f0
Revises: fc76e073e6b3
Create Date: 2026-10-10 02:08:01.061204

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "cce4cbf9b9f0"
down_revision: str | Sequence[str] | None = "fc76e073e6b3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Every table in the public schema the app owns, except Alembic's own bookkeeping.
TABLES_SQL = """
    SELECT format('%I.%I', schemaname, tablename)
    FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> 'alembic_version'
"""


def upgrade() -> None:
    """Turn on row-level security everywhere, with no policies.

    Supabase publishes the `public` schema through PostgREST to its `anon` and
    `authenticated` roles. With RLS on and no policy, those roles see no rows at all,
    whatever the dashboard's Data API switch says — so children's records cannot be read
    with the public key that ships in the website. The app is unaffected: it connects as
    the tables' owner, which RLS does not restrict (no FORCE).

    `test_every_table_has_row_level_security` fails for any table added later without it.
    """
    op.execute(
        f"""
        DO $$
        DECLARE t text;
        BEGIN
            FOR t IN {TABLES_SQL} LOOP
                EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
            END LOOP;
        END $$;
        """
    )


def downgrade() -> None:
    op.execute(
        f"""
        DO $$
        DECLARE t text;
        BEGIN
            FOR t IN {TABLES_SQL} LOOP
                EXECUTE format('ALTER TABLE %s DISABLE ROW LEVEL SECURITY', t);
            END LOOP;
        END $$;
        """
    )
