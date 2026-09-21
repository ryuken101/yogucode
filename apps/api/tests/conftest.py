"""Test fixtures.

Migrations are applied to the test database once per session, from empty. A broken
migration therefore fails the test run — there is no separate "does it migrate" step to
forget to run.

Each test then gets a session inside a transaction that is rolled back afterwards, so
tests never see each other's rows.
"""

import os
import subprocess
from collections.abc import AsyncGenerator
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel.ext.asyncio.session import AsyncSession

from app.config import get_settings

API_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="session")
def database_url() -> str:
    return get_settings().test_database_url


@pytest.fixture(scope="session")
def run_alembic(database_url: str):
    """Run an alembic command against the test database."""

    def _run(*args: str) -> subprocess.CompletedProcess[str]:
        env = {**os.environ, "ALEMBIC_DATABASE_URL": database_url}
        return subprocess.run(
            ["alembic", *args], cwd=API_ROOT, env=env, capture_output=True, text=True
        )

    return _run


@pytest.fixture(scope="session", autouse=True)
def migrated_database(run_alembic) -> None:
    """Bring the test database to head from empty, proving the migration both ways."""
    for args in (("downgrade", "base"), ("upgrade", "head")):
        result = run_alembic(*args)
        assert result.returncode == 0, result.stdout + result.stderr


@pytest.fixture
async def session(database_url: str) -> AsyncGenerator[AsyncSession, None]:
    engine = create_async_engine(database_url, poolclass=NullPool)
    connection = await engine.connect()
    transaction = await connection.begin()
    # create_savepoint keeps a test's own rollback — after an expected IntegrityError,
    # say — from tearing down the outer transaction this fixture owns.
    factory = async_sessionmaker(
        bind=connection,
        class_=AsyncSession,
        expire_on_commit=False,
        join_transaction_mode="create_savepoint",
    )
    async with factory() as db_session:
        yield db_session
    await transaction.rollback()
    await connection.close()
    await engine.dispose()
