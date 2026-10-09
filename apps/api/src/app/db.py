"""Database engine and session dependency."""

from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel.ext.asyncio.session import AsyncSession

from app.config import get_settings

NO_STATEMENT_CACHE = {"statement_cache_size": 0, "prepared_statement_cache_size": 0}


def create_engine(url: str | None = None):
    """Create the async engine.

    NullPool is deliberate: staging and production run through Supabase's Supavisor
    pooler in transaction mode, which does its own pooling. A second pool on top of it
    exhausts connections under trivial load. Configured here rather than discovered
    later from intermittent staging failures.
    """
    settings = get_settings()
    return create_async_engine(
        url or settings.database_url,
        poolclass=NullPool,
        # Supavisor in transaction mode hands each transaction to whichever server
        # connection is free, so a statement asyncpg prepared on one may be run on another
        # ("prepared statement … does not exist"). Turning asyncpg's statement caches off is
        # the documented fix; against local Postgres it costs nothing measurable.
        connect_args=NO_STATEMENT_CACHE,
    )


engine = create_engine()
async_session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_factory() as session:
        yield session
