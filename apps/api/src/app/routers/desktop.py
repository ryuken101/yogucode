"""A teacher's saved desktop layout: `GET` / `PUT /me/desktop` (16 Oct 2026).

The web app is a dock of app windows (Ken's decision). A teacher's arrangement — which
windows are open, where, and on which page — is saved to their account so it follows them
between centre laptops. The whole layout is replaced on each save; the web app debounces.

Teacher only. Students' windows are fixed, so they have nothing to save. The layout is a
teacher's own preference, not a child's record, so it is not audited.

Paths are stored as the app's own URLs and are not trusted on the way back out: the web
app re-resolves each one through the route table, so a stale or edited path just opens
that app's start page.
"""

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import CurrentTeacher
from app.db import get_session
from app.models import DesktopLayout
from app.models.base import utcnow

router = APIRouter(prefix="/me/desktop", tags=["desktop"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]

MAX_WINDOWS = 20


class WindowState(BaseModel):
    """One window. Geometry is a fraction of the desktop area, so it survives a new screen."""

    app: str = Field(min_length=1, max_length=32, pattern=r"^[a-z][a-z0-9-]*$")
    path: str = Field(min_length=1, max_length=300, pattern=r"^/")
    x: float = Field(ge=-1, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(gt=0, le=1)
    h: float = Field(gt=0, le=1)
    max: bool = False
    min: bool = False
    z: int = Field(default=0, ge=0, le=1_000_000)


class DesktopIn(BaseModel):
    windows: list[WindowState] = Field(default_factory=list, max_length=MAX_WINDOWS)
    class_id: str | None = Field(default=None, max_length=40)


class DesktopOut(DesktopIn):
    saved: bool


@router.get("", response_model=DesktopOut)
async def read_my_desktop(principal: CurrentTeacher, session: SessionDep) -> DesktopOut:
    """The saved layout, or `saved: false` for a teacher who has never arranged one."""
    row = await session.get(DesktopLayout, principal.subject_id)
    if row is None or row.centre_id != principal.centre_id:
        return DesktopOut(windows=[], class_id=None, saved=False)
    return DesktopOut(**DesktopIn.model_validate(row.layout).model_dump(), saved=True)


@router.put("", response_model=DesktopOut)
async def save_my_desktop(
    body: DesktopIn, principal: CurrentTeacher, session: SessionDep
) -> DesktopOut:
    row = await session.get(DesktopLayout, principal.subject_id)
    layout = body.model_dump()
    if row is None:
        row = DesktopLayout(user_id=principal.subject_id, centre_id=principal.centre_id)
    row.centre_id = principal.centre_id
    row.layout = layout
    row.updated_at = utcnow()
    session.add(row)
    await session.commit()
    return DesktopOut(**layout, saved=True)
