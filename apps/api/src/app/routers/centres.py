"""The signed-in teacher's centre.

Read-only by design. The slug is the centre's identity and lives in config, so renaming
is a config change rather than a write that would let the database and config drift
apart. There is no create or delete: provisioning makes the one centre on first sign-in.
"""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import CurrentTeacher
from app.db import get_session
from app.schemas import CentreOut
from app.scoping import get_centre

router = APIRouter(prefix="/centre", tags=["centre"])


@router.get("", response_model=CentreOut)
async def read_centre(
    principal: CurrentTeacher,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> CentreOut:
    return CentreOut.build(await get_centre(session, principal))
