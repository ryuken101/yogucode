"""The live classroom over real WebSockets: who may join, and what reaches whom.

The authorisation tests lead. Every refusal is the thing that matters: a child's code is
on the wire here, keystroke by keystroke, so a teacher from another centre watching, or a
child writing into another child's editor, would be a leak of children's work as it
happens.

`httpx-ws` runs the sockets inside the test's own event loop, so they share the rolled-back
database session every other test uses.
"""

import asyncio
import contextlib

import httpx
import pytest
from httpx_ws import WebSocketDisconnect, aconnect_ws
from httpx_ws.transport import ASGIWebSocketTransport

from app.live.hub import hub
from app.main import app as fastapi_app
from work_builders import open_first, today


@contextlib.asynccontextmanager
async def sockets(client: httpx.AsyncClient):
    """A WebSocket-capable client carrying the HTTP client's cookies.

    Opened inside each test, not as a fixture: the WebSocket transport must be entered and
    exited in the same task, and pytest-asyncio runs fixture setup and teardown in
    different ones. The `client` fixture has already installed the dependency overrides.
    """
    async with httpx.AsyncClient(
        transport=ASGIWebSocketTransport(app=fastapi_app),
        base_url="http://test",
        cookies=client.cookies,
    ) as ws_client:
        yield ws_client


@pytest.fixture(autouse=True)
def fresh_hub():
    hub.rooms.clear()
    yield
    hub.rooms.clear()


def token_of(headers: dict) -> str:
    return headers["Authorization"].removeprefix("Bearer ")


async def closed_with(ws) -> int:
    with pytest.raises(WebSocketDisconnect) as caught:
        await ws.receive_json(timeout=2)
    return caught.value.code


async def next_of(ws, kind: str, timeout: float = 2):
    """The next message of a kind, skipping the rest."""
    while True:
        message = await ws.receive_json(timeout=timeout)
        if message["type"] == kind:
            return message


# --- who may join -----------------------------------------------------------------------


async def test_a_socket_without_a_session_is_refused(client) -> None:
    async with (
        sockets(client) as ws_client,
        aconnect_ws("http://test/live/student", ws_client) as ws,
    ):
        assert await closed_with(ws) == 4401


async def test_a_teacher_must_say_who_they_are_first(client) -> None:
    async with (
        sockets(client) as ws_client,
        aconnect_ws("http://test/live/teacher", ws_client) as ws,
    ):
        await ws.send_json({"type": "watch"})
        assert await closed_with(ws) == 4401


async def test_a_forged_teacher_token_is_refused(client) -> None:
    async with (
        sockets(client) as ws_client,
        aconnect_ws("http://test/live/teacher", ws_client) as ws,
    ):
        await ws.send_json({"type": "auth", "token": "not-a-jwt", "class_id": "x"})
        assert await closed_with(ws) == 4401


async def test_a_teacher_cannot_watch_another_centres_class(
    client, signed_in, foreign_centre
) -> None:
    headers = await signed_in()
    async with (
        sockets(client) as ws_client,
        aconnect_ws("http://test/live/teacher", ws_client) as ws,
    ):
        await ws.send_json(
            {
                "type": "auth",
                "token": token_of(headers),
                "class_id": str(foreign_centre["class"].id),
            }
        )
        assert await closed_with(ws) == 4404


async def test_a_child_cannot_publish_another_childs_editor(
    client, session, signed_in_student
) -> None:
    aria = await signed_in_student("Aria K")
    await today(client, session, aria)
    arias = (await open_first(client))["leaves"][0]["attempt"]["id"]
    await signed_in_student("Bella N")

    async with (
        sockets(client) as ws_client,
        aconnect_ws("http://test/live/student", ws_client) as ws,
    ):
        await next_of(ws, "ready")
        await ws.send_json(
            {"type": "doc", "target": f"attempt:{arias}", "update": "AAA=", "full": True}
        )
        refused = await next_of(ws, "refused")
        assert refused["target"] == f"attempt:{arias}"
        assert all(not room.docs for room in hub.rooms.values())


# --- what reaches whom -------------------------------------------------------------------


async def test_a_teacher_sees_a_child_arrive_focus_and_type(
    client, session, signed_in_student
) -> None:
    aria = await signed_in_student()
    await today(client, session, aria)
    attempt = (await open_first(client))["leaves"][0]["attempt"]["id"]
    target = f"attempt:{attempt}"

    async with (
        sockets(client) as ws_client,
        aconnect_ws("http://test/live/teacher", ws_client) as teacher,
    ):
        await teacher.send_json(
            {"type": "auth", "token": token_of(aria["headers"]), "class_id": aria["class_id"]}
        )
        snapshot = await next_of(teacher, "snapshot")
        assert snapshot["students"] == []

        async with aconnect_ws("http://test/live/student", ws_client) as child:
            await next_of(child, "ready")
            joined = await next_of(teacher, "joined")
            assert joined["display_name"] == "Aria K"

            await child.send_json({"type": "focus", "focus": {"target": target, "title": "Q1"}})
            assert (await next_of(teacher, "focus"))["focus"]["title"] == "Q1"

            await child.send_json({"type": "doc", "target": target, "update": "FULL", "full": True})
            await child.send_json({"type": "doc", "target": target, "update": "D1"})
            first, second = await next_of(teacher, "doc"), await next_of(teacher, "doc")
            assert (first["update"], first["full"], second["update"]) == ("FULL", True, "D1")

            await child.send_json({"type": "status", "status": {"kind": "run"}})
            assert (await next_of(teacher, "status"))["status"] == {"kind": "run"}

        assert (await next_of(teacher, "left"))["student_id"] == aria["student_id"]


async def test_a_late_teacher_rebuilds_the_document_from_the_log(
    client, session, signed_in_student
) -> None:
    aria = await signed_in_student()
    await today(client, session, aria)
    target = f"attempt:{(await open_first(client))['leaves'][0]['attempt']['id']}"

    async with (
        sockets(client) as ws_client,
        aconnect_ws("http://test/live/student", ws_client) as child,
    ):
        await next_of(child, "ready")
        for update, full in [("OLD", True), ("X", False), ("NEW", True), ("Y", False)]:
            await child.send_json({"type": "doc", "target": target, "update": update, "full": full})
        check = {
            "kind": "check",
            "target": target,
            "passed": 1,
            "total": 2,
            "compile_error": None,
        }
        await child.send_json({"type": "status", "status": check})
        await asyncio.sleep(0.1)

        async with aconnect_ws("http://test/live/teacher", ws_client) as teacher:
            await teacher.send_json(
                {
                    "type": "auth",
                    "token": token_of(aria["headers"]),
                    "class_id": aria["class_id"],
                }
            )
            snapshot = await next_of(teacher, "snapshot")
        # A full state resets the log: a late teacher replays from it, not from the start.
        assert snapshot["docs"] == [
            {"target": target, "student_id": aria["student_id"], "updates": ["NEW", "Y"]}
        ]
        assert snapshot["students"][0]["recent"] == [check]


async def test_a_teacher_types_into_a_childs_open_editor(
    client, session, signed_in_student
) -> None:
    aria = await signed_in_student()
    await today(client, session, aria)
    target = f"attempt:{(await open_first(client))['leaves'][0]['attempt']['id']}"

    async with (
        sockets(client) as ws_client,
        aconnect_ws("http://test/live/student", ws_client) as child,
    ):
        await next_of(child, "ready")
        await child.send_json({"type": "doc", "target": target, "update": "FULL", "full": True})
        # Let the publish settle first: the test shares one database session across
        # sockets, which the real app never does (one session per socket).
        await asyncio.sleep(0.2)
        async with aconnect_ws("http://test/live/teacher", ws_client) as teacher:
            await teacher.send_json(
                {
                    "type": "auth",
                    "token": token_of(aria["headers"]),
                    "class_id": aria["class_id"],
                }
            )
            await next_of(teacher, "snapshot")
            await teacher.send_json({"type": "doc", "target": target, "update": "HELP"})
            arrived = await next_of(child, "doc")
            assert (arrived["target"], arrived["update"]) == (target, "HELP")

            # Only into an editor a child actually has open in this class.
            await teacher.send_json(
                {
                    "type": "doc",
                    "target": "attempt:018f0000-0000-7000-8000-000000000999",
                    "update": "X",
                }
            )
            assert (await next_of(teacher, "refused"))["target"].endswith("999")


async def test_cursors_travel_both_ways_but_only_for_an_open_editor(
    client, session, signed_in_student
) -> None:
    aria = await signed_in_student()
    await today(client, session, aria)
    target = f"attempt:{(await open_first(client))['leaves'][0]['attempt']['id']}"

    async with (
        sockets(client) as ws_client,
        aconnect_ws("http://test/live/student", ws_client) as child,
    ):
        await next_of(child, "ready")
        await child.send_json({"type": "doc", "target": target, "update": "FULL", "full": True})
        await asyncio.sleep(0.2)
        async with aconnect_ws("http://test/live/teacher", ws_client) as teacher:
            await teacher.send_json(
                {"type": "auth", "token": token_of(aria["headers"]), "class_id": aria["class_id"]}
            )
            await next_of(teacher, "snapshot")

            await child.send_json({"type": "cursor", "target": target, "offset": 12})
            seen = await next_of(teacher, "cursor")
            assert (seen["target"], seen["offset"]) == (target, 12)

            await teacher.send_json({"type": "cursor", "target": target, "offset": 3})
            assert (await next_of(child, "cursor"))["offset"] == 3

            # A cursor for an editor the child never opened goes nowhere.
            await child.send_json(
                {
                    "type": "cursor",
                    "target": "attempt:018f0000-0000-7000-8000-000000000999",
                    "offset": 1,
                }
            )
            with pytest.raises(TimeoutError):
                await next_of(teacher, "cursor", timeout=0.5)


# --- Help locks the child's editor (Ken's decision, 11 Oct 2026) -----------------------


async def test_help_locks_the_childs_editor_and_leaving_unlocks_it(
    client, session, signed_in_student
) -> None:
    aria = await signed_in_student()
    await today(client, session, aria)
    target = f"attempt:{(await open_first(client))['leaves'][0]['attempt']['id']}"

    async with (
        sockets(client) as ws_client,
        aconnect_ws("http://test/live/student", ws_client) as child,
    ):
        await next_of(child, "ready")
        await child.send_json({"type": "doc", "target": target, "update": "FULL", "full": True})
        await asyncio.sleep(0.2)
        async with aconnect_ws("http://test/live/teacher", ws_client) as teacher:
            await teacher.send_json(
                {"type": "auth", "token": token_of(aria["headers"]), "class_id": aria["class_id"]}
            )
            await next_of(teacher, "snapshot")

            await teacher.send_json({"type": "help", "target": target, "on": True})
            locked = await next_of(child, "help")
            assert (locked["target"], locked["on"]) == (target, True)

            await teacher.send_json({"type": "help", "target": target, "on": False})
            assert (await next_of(child, "help"))["on"] is False

            # On again, then the teacher simply goes (tab closed, connection lost)...
            await teacher.send_json({"type": "help", "target": target, "on": True})
            assert (await next_of(child, "help"))["on"] is True
        # ...and the child is never left locked.
        unlocked = await next_of(child, "help")
        assert (unlocked["target"], unlocked["on"]) == (target, False)


async def test_signing_a_child_out_closes_their_live_connection(
    client, session, signed_in_student
) -> None:
    """Sockets check the session only when they open. Before 23 Oct 2026 a child signed out
    by their teacher kept streaming to the Live view and could still be helped."""
    aria = await signed_in_student()
    async with (
        sockets(client) as ws_client,
        aconnect_ws("http://test/live/teacher", ws_client) as teacher,
    ):
        await teacher.send_json(
            {"type": "auth", "token": token_of(aria["headers"]), "class_id": aria["class_id"]}
        )
        await next_of(teacher, "snapshot")
        async with aconnect_ws("http://test/live/student", ws_client) as child:
            await next_of(child, "ready")
            await next_of(teacher, "joined")

            await client.post(
                f"/students/{aria['student_id']}/sessions/revoke", headers=aria["headers"]
            )
            assert await closed_with(child) == 4401
            assert (await next_of(teacher, "left"))["student_id"] == aria["student_id"]


async def test_a_child_cannot_put_made_up_things_on_the_teachers_screen() -> None:
    from app.routers.live import clean_status

    mine = {"attempt:a1"}
    assert clean_status({"kind": "run", "evil": "x" * 9000}, mine) == {"kind": "run"}
    assert clean_status({"kind": "check", "target": "attempt:a1", "passed": 3, "total": 3}, mine)
    # A result for an editor this connection never proved it owns is dropped...
    assert (
        clean_status({"kind": "check", "target": "attempt:zz", "passed": 3, "total": 3}, mine)
        is None
    )
    # ...as is nonsense, and anything that is not a known kind.
    assert (
        clean_status({"kind": "check", "target": "attempt:a1", "passed": 9, "total": 3}, mine)
        is None
    )
    assert (
        clean_status({"kind": "check", "target": "attempt:a1", "passed": "3", "total": 3}, mine)
        is None
    )
    assert clean_status({"kind": "html", "text": "<b>"}, mine) is None
    assert clean_status("run", mine) is None


async def test_removing_a_teacher_closes_their_live_views_and_unlocks_help() -> None:
    import uuid

    local, class_id, _, child = await _room_with_child()
    removed, other = uuid.uuid4(), uuid.uuid4()
    theirs, colleague = ClosableSocket(), ClosableSocket()
    await local.join_teacher(class_id, theirs, removed)
    await local.join_teacher(class_id, colleague, other)
    await local.help(class_id, theirs, "document:d1", on=True)

    await local.kick_teacher(removed)
    assert theirs.closed == 4403
    assert colleague.closed is None
    assert child.helps() == [("document:d1", True), ("document:d1", False)]


class FakeSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, data) -> None:
        self.sent.append(data)

    def helps(self) -> list[tuple[str, bool]]:
        return [(m["target"], m["on"]) for m in self.sent if m["type"] == "help"]


class ClosableSocket(FakeSocket):
    def __init__(self) -> None:
        super().__init__()
        self.closed: int | None = None

    async def close(self, code: int) -> None:
        self.closed = code


async def _room_with_child():
    import uuid

    from app.live.hub import Hub, StudentPresence

    local = Hub()
    class_id, student_id = uuid.uuid4(), uuid.uuid4()
    child = FakeSocket()
    await local.join_student(class_id, StudentPresence(child, student_id, "Aria K"))
    await local.student_doc(class_id, student_id, "document:d1", "FULL", full=True)
    return local, class_id, student_id, child


async def test_two_helpers_unlock_only_when_both_stop() -> None:
    local, class_id, _, child = await _room_with_child()
    ken, sam = FakeSocket(), FakeSocket()
    await local.help(class_id, ken, "document:d1", on=True)
    await local.help(class_id, sam, "document:d1", on=True)
    await local.help(class_id, ken, "document:d1", on=False)
    assert child.helps() == [("document:d1", True)], "still locked while Sam helps"
    await local.leave_teacher(class_id, sam)
    assert child.helps() == [("document:d1", True), ("document:d1", False)]


async def test_a_child_reconnecting_mid_help_is_told_they_are_locked() -> None:
    from app.live.hub import StudentPresence

    local, class_id, student_id, _ = await _room_with_child()
    await local.help(class_id, FakeSocket(), "document:d1", on=True)

    again = FakeSocket()  # the child's new connection, after a reload
    await local.join_student(class_id, StudentPresence(again, student_id, "Aria K"))
    await local.student_doc(class_id, student_id, "document:d1", "FULL", full=True)
    assert again.helps() == [("document:d1", True)]


async def test_help_on_an_editor_nobody_has_open_is_refused() -> None:
    local, class_id, _, child = await _room_with_child()
    assert await local.help(class_id, FakeSocket(), "document:nope", on=True) is False
    assert child.helps() == []
