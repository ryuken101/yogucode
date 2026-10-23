"""The live classroom: who is connected, what they are working on, and their code as typed.

One **room per class**. In it:

- **students** — each child's socket, which problem or file they have open (`focus`), and
  a short history of what happened (runs, checks, errors, pastes) for the stuck signals;
- **teachers** — every teacher socket watching the class;
- **documents** — for every editor a child has open, the log of Yjs updates since the
  child last sent their full state.

The server is a **relay**, not a participant: it never interprets a Yjs update. A child's
browser owns the document and sends its full state on (re)connect, which resets the log;
after that, deltas. A teacher arriving late is sent the log and rebuilds the document
exactly. When a teacher types into a child's editor ("help"), their update travels the
same way in reverse. Because Yjs is a CRDT, two people typing at once converge without
the server doing anything clever.

**In memory, one process.** Spec §5.5: plain WebSockets and a dict, and Redis pub/sub
only once there is more than one API process. Fly runs one machine until then. A restart
loses nothing that matters: every child's browser reconnects and resends its state, and
persistence is the child's own autosave, not this.

Nothing here touches the database. Authorisation — who may join which room, which
documents a child may publish — is decided in `routers/live.py`, through `app.scoping`,
before anything reaches the hub.
"""

import asyncio
import contextlib
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Protocol

# A document's log is replayed to every teacher who joins, so it is bounded. Past this,
# the child is asked for a fresh full state, which replaces the log with one entry.
MAX_LOG = 1_000
# Enough recent activity per child for the stuck signals ("same error 4 times", "no run
# in 5 minutes") to be computed by a teacher who has only just opened the page.
MAX_RECENT_STATUS = 50


class Socket(Protocol):
    async def send_json(self, data: Any) -> None: ...


# Close codes, as in `routers/live.py`.
SIGNED_OUT, REMOVED = 4401, 4403


@dataclass
class StudentPresence:
    socket: Socket
    student_id: uuid.UUID
    display_name: str
    focus: dict[str, Any] | None = None
    recent: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=MAX_RECENT_STATUS))
    # Documents this connection has proven it may publish (checked once, in the router).
    targets: set[str] = field(default_factory=set)


@dataclass
class DocLog:
    student_id: uuid.UUID
    updates: list[str] = field(default_factory=list)


@dataclass
class Room:
    class_id: uuid.UUID
    students: dict[uuid.UUID, StudentPresence] = field(default_factory=dict)
    teachers: set[Socket] = field(default_factory=set)
    # Whose each teacher socket is, so removing a teacher can close what they have open.
    teacher_users: dict[Socket, uuid.UUID] = field(default_factory=dict)
    docs: dict[str, DocLog] = field(default_factory=dict)
    # Which teachers are helping in which child's editor. While a target has anyone in its
    # set, the child's editor is locked (Ken's decision, 11 Oct 2026): they watch rather
    # than type over the teacher.
    helping: dict[str, set[Socket]] = field(default_factory=dict)


async def _send(socket: Socket, message: dict[str, Any]) -> None:
    """Send, and shrug off a socket that has just gone — its own handler will clean up."""
    with contextlib.suppress(Exception):
        await socket.send_json(message)


async def _close(socket: Socket, code: int) -> None:
    """Close from the server side. The socket's own handler then sees the disconnect."""
    close = getattr(socket, "close", None)
    if close is not None:
        with contextlib.suppress(Exception):
            await close(code)


class Hub:
    def __init__(self) -> None:
        self.rooms: dict[uuid.UUID, Room] = {}

    def room(self, class_id: uuid.UUID) -> Room:
        return self.rooms.setdefault(class_id, Room(class_id))

    async def _to_teachers(self, room: Room, message: dict[str, Any], skip: Socket | None = None):
        await asyncio.gather(*(_send(t, message) for t in list(room.teachers) if t is not skip))

    # --- students -------------------------------------------------------------------

    async def join_student(self, class_id: uuid.UUID, presence: StudentPresence) -> None:
        room = self.room(class_id)
        previous = room.students.get(presence.student_id)
        room.students[presence.student_id] = presence
        if previous is not None and previous.socket is not presence.socket:
            # The same child in a second tab: the newest connection wins, and the old one
            # is told so rather than silently going deaf.
            await _send(previous.socket, {"type": "replaced"})
        await self._to_teachers(room, {"type": "joined", **self._presence(presence)})

    async def leave_student(self, class_id: uuid.UUID, student_id: uuid.UUID, socket: Socket):
        room = self.rooms.get(class_id)
        if room is None:
            return
        current = room.students.get(student_id)
        if current is None or current.socket is not socket:
            return  # a newer tab already replaced this one
        del room.students[student_id]
        await self._to_teachers(room, {"type": "left", "student_id": str(student_id)})

    async def kick_student(self, student_id: uuid.UUID) -> None:
        """A child's sessions were revoked (signed out by a teacher, removed, archived,
        trashed or erased): close their live connection now, not when they next reconnect.

        Sockets check the session only when they open, so without this a signed-out child
        kept streaming to the Live view and receiving Help (found 23 Oct 2026).
        """
        for room in list(self.rooms.values()):
            presence = room.students.pop(student_id, None)
            if presence is None:
                continue
            for target in [t for t, log in room.docs.items() if log.student_id == student_id]:
                del room.docs[target]
                room.helping.pop(target, None)
            await self._to_teachers(room, {"type": "left", "student_id": str(student_id)})
            await _close(presence.socket, SIGNED_OUT)

    def is_helped(self, target: str) -> bool:
        """Whether a teacher is helping in this editor, so the child's own saves must wait."""
        return any(room.helping.get(target) for room in self.rooms.values())

    async def focus(self, class_id: uuid.UUID, student_id: uuid.UUID, focus: dict[str, Any]):
        room = self.room(class_id)
        presence = room.students.get(student_id)
        if presence is None:
            return
        presence.focus = focus
        await self._to_teachers(
            room, {"type": "focus", "student_id": str(student_id), "focus": focus}
        )

    async def status(self, class_id: uuid.UUID, student_id: uuid.UUID, status: dict[str, Any]):
        room = self.room(class_id)
        presence = room.students.get(student_id)
        if presence is None:
            return
        presence.recent.append(status)
        await self._to_teachers(
            room, {"type": "status", "student_id": str(student_id), "status": status}
        )

    async def student_doc(
        self,
        class_id: uuid.UUID,
        student_id: uuid.UUID,
        target: str,
        update: str,
        *,
        full: bool,
    ) -> None:
        """A child's edit (or, with `full`, their whole document state)."""
        room = self.room(class_id)
        log = room.docs.get(target)
        if log is None or full or log.student_id != student_id:
            log = room.docs[target] = DocLog(student_id)
            log.updates = [update]
            if room.helping.get(target):
                # A child (re)connecting mid-help learns their editor is locked: they send
                # their full state on every connect, so this is where to tell them.
                presence = room.students.get(student_id)
                if presence is not None:
                    await _send(presence.socket, {"type": "help", "target": target, "on": True})
        else:
            log.updates.append(update)
        if len(log.updates) > MAX_LOG:
            presence = room.students.get(student_id)
            if presence is not None:
                await _send(presence.socket, {"type": "resync", "target": target})
        await self._to_teachers(
            room,
            {
                "type": "doc",
                "student_id": str(student_id),
                "target": target,
                "update": update,
                "full": full,
            },
        )

    async def student_cursor(
        self, class_id: uuid.UUID, student_id: uuid.UUID, target: str, offset: int
    ) -> None:
        """Where the child's cursor is, so a helping teacher can see it. Not logged."""
        room = self.rooms.get(class_id)
        log = room.docs.get(target) if room else None
        if room is None or log is None or log.student_id != student_id:
            return
        await self._to_teachers(
            room,
            {"type": "cursor", "student_id": str(student_id), "target": target, "offset": offset},
        )

    # --- teachers -------------------------------------------------------------------

    async def join_teacher(
        self, class_id: uuid.UUID, socket: Socket, user_id: uuid.UUID | None = None
    ) -> None:
        """Watch a class: receive everyone's presence, recent activity and documents."""
        room = self.room(class_id)
        room.teachers.add(socket)
        if user_id is not None:
            room.teacher_users[socket] = user_id
        await _send(
            socket,
            {
                "type": "snapshot",
                "students": [
                    {**self._presence(p), "recent": list(p.recent)} for p in room.students.values()
                ],
                "docs": [
                    {"target": target, "student_id": str(log.student_id), "updates": log.updates}
                    for target, log in room.docs.items()
                ],
            },
        )

    async def leave_teacher(self, class_id: uuid.UUID, socket: Socket) -> None:
        """A teacher went: their tab closed, they navigated away, or the connection dropped.

        Every editor they were helping in unlocks, so a child is never left stuck unable to
        type because a teacher walked off.
        """
        room = self.rooms.get(class_id)
        if room is None:
            return
        room.teachers.discard(socket)
        room.teacher_users.pop(socket, None)
        for target in [t for t, helpers in room.helping.items() if socket in helpers]:
            await self.help(class_id, socket, target, on=False)

    async def kick_teacher(self, user_id: uuid.UUID) -> None:
        """The owner removed this teacher: close every class they are watching. Leaving
        unlocks any editor they were helping in, exactly as if their tab had closed."""
        for room in list(self.rooms.values()):
            for socket in [s for s, uid in room.teacher_users.items() if uid == user_id]:
                await self.leave_teacher(room.class_id, socket)
                await _close(socket, REMOVED)

    async def help(self, class_id: uuid.UUID, socket: Socket, target: str, *, on: bool) -> bool:
        """A teacher starts or stops helping in a child's editor. False if no such editor.

        The child is told only when their editor changes state: locked when the first
        teacher starts helping, unlocked when the last one stops.
        """
        room = self.rooms.get(class_id)
        log = room.docs.get(target) if room else None
        if room is None or log is None:
            return False
        helpers = room.helping.setdefault(target, set())
        was_locked = bool(helpers)
        if on:
            helpers.add(socket)
        else:
            helpers.discard(socket)
        if not helpers:
            del room.helping[target]
        now_locked = bool(room.helping.get(target))
        if now_locked != was_locked:
            presence = room.students.get(log.student_id)
            if presence is not None:
                await _send(presence.socket, {"type": "help", "target": target, "on": now_locked})
        return True

    async def teacher_doc(
        self, class_id: uuid.UUID, socket: Socket, target: str, update: str
    ) -> bool:
        """A teacher's edit to a child's document ("help"). False if there is no such document
        open in this class — a teacher can only type into an editor a child has open."""
        room = self.rooms.get(class_id)
        log = room.docs.get(target) if room else None
        if room is None or log is None:
            return False
        presence = room.students.get(log.student_id)
        if presence is None:
            return False
        log.updates.append(update)
        await _send(presence.socket, {"type": "doc", "target": target, "update": update})
        await self._to_teachers(
            room,
            {
                "type": "doc",
                "student_id": str(log.student_id),
                "target": target,
                "update": update,
                "full": False,
                "by_teacher": True,
            },
            skip=socket,
        )
        return True

    async def teacher_cursor(
        self, class_id: uuid.UUID, socket: Socket, target: str, offset: int | None
    ) -> None:
        """Where a helping teacher's cursor is, shown in the child's editor; None hides it."""
        room = self.rooms.get(class_id)
        log = room.docs.get(target) if room else None
        presence = room.students.get(log.student_id) if room and log else None
        if presence is not None:
            await _send(presence.socket, {"type": "cursor", "target": target, "offset": offset})

    async def to_students(self, class_id: uuid.UUID, message: dict[str, Any]) -> None:
        """Tell every connected child in the class something — a quiz starting, or ending."""
        room = self.rooms.get(class_id)
        if room is not None:
            await asyncio.gather(*(_send(p.socket, message) for p in list(room.students.values())))

    async def to_teachers(self, class_id: uuid.UUID, message: dict[str, Any]) -> None:
        room = self.rooms.get(class_id)
        if room is not None:
            await self._to_teachers(room, message)

    @staticmethod
    def _presence(p: StudentPresence) -> dict[str, Any]:
        return {"student_id": str(p.student_id), "display_name": p.display_name, "focus": p.focus}


hub = Hub()
