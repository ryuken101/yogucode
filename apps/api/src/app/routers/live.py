"""The live classroom's two WebSocket doors: one for children, one for teachers.

**Who may come in is decided here, through the same code the HTTP routes use.** The hub
(`app/live/hub.py`) trusts whatever reaches it, so nothing reaches it unchecked:

- **A child** is identified by their session cookie (`resolve_session`), exactly as on
  every `/me` route, and is put in the room of their own class (`get_student_class`).
  Each document they publish is checked once against `get_own_attempt` /
  `get_owned_document` — a child cannot stream text into another child's editor by naming
  it.
- **A teacher** cannot send an `Authorization` header from a browser WebSocket, so the
  first message carries the Supabase token. It is verified with the same verifier and
  active-account check as every teacher request (`verify_teacher_token`, `load_teacher`), and the
  class they ask to watch goes through `get_owned_class` — another centre's class is
  refused like a 404.

**A socket lives for a lesson; a database connection must not.** The pooler runs in
transaction mode (`db.py`), so each check commits straight away and the connection goes
back. The socket then holds nothing but memory.

Close codes: 4401 not signed in, 4403 not allowed, 4404 not found or not yours.
"""

import asyncio
import contextlib
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import (
    STUDENT_SESSION_COOKIE,
    Principal,
    load_teacher,
    verify_teacher_token,
)
from app.auth.student_session import resolve_session
from app.auth.supabase_jwt import SupabaseJWKSVerifier, get_verifier
from app.config import Settings, get_settings
from app.db import get_session
from app.live.hub import StudentPresence, hub
from app.scoping import get_own_attempt, get_owned_class, get_owned_document, get_student_class

router = APIRouter(tags=["live"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
VerifierDep = Annotated[SupabaseJWKSVerifier, Depends(get_verifier)]

UNAUTHENTICATED, FORBIDDEN, NOT_FOUND = 4401, 4403, 4404
# A teacher has this long after connecting to say who they are.
AUTH_TIMEOUT_SECONDS = 10
# A Yjs update for a child-sized program. The full state of a 64 KB file, base64-encoded,
# fits comfortably; anything larger is not a keystroke.
MAX_UPDATE_CHARS = 200_000
MAX_STATUS_CHARS = 4_000


class LockedSocket:
    """A WebSocket that sends one message at a time.

    The hub fans a message out to many sockets concurrently, and one socket can be the
    target of two fan-outs at once (a child's keystroke and a teacher's edit). Interleaved
    sends on one connection are not safe, so each socket serialises its own.
    """

    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        self._lock = asyncio.Lock()

    async def send_json(self, data: Any) -> None:
        async with self._lock:
            await self.websocket.send_json(data)


def parse_target(target: object) -> tuple[str, uuid.UUID] | None:
    """`attempt:<uuid>` or `document:<uuid>` — the two kinds of editor there are."""
    if not isinstance(target, str):
        return None
    kind, _, raw = target.partition(":")
    if kind not in ("attempt", "document"):
        return None
    try:
        return kind, uuid.UUID(raw)
    except ValueError:
        return None


async def _close(websocket: WebSocket, code: int) -> None:
    with contextlib.suppress(Exception):
        await websocket.close(code=code)


async def _may_publish(session: AsyncSession, principal: Principal, target: str) -> bool:
    parsed = parse_target(target)
    if parsed is None:
        return False
    kind, target_id = parsed
    try:
        if kind == "attempt":
            await get_own_attempt(session, principal, target_id)
        else:
            await get_owned_document(session, principal, target_id)
    except HTTPException:
        return False
    finally:
        await session.commit()
    return True


@router.websocket("/live/student")
async def student_socket(websocket: WebSocket, session: SessionDep, settings: SettingsDep):
    await websocket.accept()
    cookie = websocket.cookies.get(STUDENT_SESSION_COOKIE)
    resolved = await resolve_session(session, cookie, settings) if cookie else None
    if resolved is None:
        await session.commit()
        return await _close(websocket, UNAUTHENTICATED)
    _, student = resolved
    principal = Principal(kind="student", subject_id=student.id, centre_id=student.centre_id)
    klass = await get_student_class(session, principal)
    await session.commit()
    if klass is None:
        return await _close(websocket, NOT_FOUND)

    socket = LockedSocket(websocket)
    presence = StudentPresence(
        socket=socket, student_id=student.id, display_name=student.display_name
    )
    await hub.join_student(klass.id, presence)
    await socket.send_json({"type": "ready", "class_id": str(klass.id)})
    try:
        while True:
            message = await websocket.receive_json()
            kind = message.get("type") if isinstance(message, dict) else None
            if kind == "focus":
                focus = message.get("focus")
                if focus is None or (isinstance(focus, dict) and len(str(focus)) < 1_000):
                    await hub.focus(klass.id, student.id, focus)
            elif kind == "status":
                status = message.get("status")
                if isinstance(status, dict) and len(str(status)) < MAX_STATUS_CHARS:
                    await hub.status(klass.id, student.id, status)
            elif kind == "cursor":
                target, offset = message.get("target"), message.get("offset")
                if target in presence.targets and isinstance(offset, int) and offset >= 0:
                    await hub.student_cursor(klass.id, student.id, target, offset)
            elif kind == "doc":
                target, update = message.get("target"), message.get("update")
                if not isinstance(update, str) or len(update) > MAX_UPDATE_CHARS:
                    continue
                if target not in presence.targets:
                    if not await _may_publish(session, principal, target):
                        await socket.send_json({"type": "refused", "target": target})
                        continue
                    presence.targets.add(target)
                await hub.student_doc(
                    klass.id, student.id, target, update, full=bool(message.get("full"))
                )
    except WebSocketDisconnect:
        pass
    finally:
        await hub.leave_student(klass.id, student.id, socket)


@router.websocket("/live/teacher")
async def teacher_socket(
    websocket: WebSocket,
    session: SessionDep,
    settings: SettingsDep,
    verifier: VerifierDep,
):
    await websocket.accept()
    try:
        first = await asyncio.wait_for(websocket.receive_json(), timeout=AUTH_TIMEOUT_SECONDS)
    except (TimeoutError, WebSocketDisconnect, ValueError):
        return await _close(websocket, UNAUTHENTICATED)
    if not isinstance(first, dict) or first.get("type") != "auth":
        return await _close(websocket, UNAUTHENTICATED)

    try:
        claims = await verify_teacher_token(str(first.get("token") or ""), verifier)
        user = await load_teacher(session, claims)
        principal = Principal(
            kind="teacher", subject_id=user.id, centre_id=user.centre_id, role=user.role
        )
        klass = await get_owned_class(session, principal, uuid.UUID(str(first.get("class_id"))))
    except HTTPException as exc:
        await session.commit()
        code = {401: UNAUTHENTICATED, 403: FORBIDDEN}.get(exc.status_code, NOT_FOUND)
        return await _close(websocket, code)
    except ValueError:
        return await _close(websocket, NOT_FOUND)
    await session.commit()

    socket = LockedSocket(websocket)
    await hub.join_teacher(klass.id, socket)
    try:
        while True:
            message = await websocket.receive_json()
            kind = message.get("type") if isinstance(message, dict) else None
            if kind == "cursor":
                target, offset = message.get("target"), message.get("offset")
                if parse_target(target) is not None and (
                    offset is None or (isinstance(offset, int) and offset >= 0)
                ):
                    await hub.teacher_cursor(klass.id, socket, target, offset)
            elif kind == "doc":
                target, update = message.get("target"), message.get("update")
                if (
                    isinstance(update, str)
                    and len(update) <= MAX_UPDATE_CHARS
                    and parse_target(target) is not None
                    and not await hub.teacher_doc(klass.id, socket, target, update)
                ):
                    await socket.send_json({"type": "refused", "target": target})
            elif kind == "help":
                # Start or stop helping: the child's editor locks while anyone helps.
                target, on = message.get("target"), message.get("on")
                if (
                    isinstance(on, bool)
                    and parse_target(target) is not None
                    and not await hub.help(klass.id, socket, target, on=on)
                ):
                    await socket.send_json({"type": "refused", "target": target})
    except WebSocketDisconnect:
        pass
    finally:
        # Unlocks every editor this teacher was helping in (hub.leave_teacher).
        await hub.leave_teacher(klass.id, socket)
