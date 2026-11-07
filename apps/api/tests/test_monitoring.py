"""The log lines that diagnose a slow class. They must never carry a child's details."""

import asyncio
import logging
import time

import httpx
import pytest
from starlette.types import Receive, Scope, Send

from app import monitoring
from app.monitoring import RequestTiming, in_flight, route_of, watch


def app_taking(seconds: float, status: int = 200):
    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        await asyncio.sleep(seconds)
        await send({"type": "http.response.start", "status": status, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    return app


async def get(app, path: str) -> httpx.Response:
    transport = httpx.ASGITransport(app=RequestTiming(app))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get(path)


def test_ids_are_removed_from_a_route() -> None:
    path = "/api/me/attempts/01a1b427-616e-70a1-92f7-23c254c8be43/runs"
    assert route_of(path) == "/api/me/attempts/:id/runs"
    assert len(route_of("/" + "x" * 500)) == 100


async def test_a_slow_request_is_logged_without_its_id_or_query(caplog, monkeypatch) -> None:
    monkeypatch.setattr(monitoring, "SLOW_REQUEST_SECONDS", 0.01)
    with caplog.at_level(logging.INFO, logger="uvicorn.error"):
        await get(
            app_taking(0.02, 500),
            "/api/me/attempts/01a1b427-616e-70a1-92f7-23c254c8be43?name=Aria",
        )
    line = next(r.getMessage() for r in caplog.records if "slow request" in r.getMessage())
    assert "GET '/api/me/attempts/:id' 500" in line
    assert "Aria" not in line
    assert "01a1b427" not in line


async def test_a_quick_request_is_not_logged(caplog) -> None:
    with caplog.at_level(logging.INFO, logger="uvicorn.error"):
        await get(app_taking(0), "/api/health")
    assert not [r for r in caplog.records if "slow request" in r.getMessage()]


async def test_a_request_that_crashes_is_still_counted_out() -> None:
    async def broken(scope: Scope, receive: Receive, send: Send) -> None:
        raise RuntimeError("boom")

    before = in_flight.requests
    with pytest.raises(RuntimeError):
        await get(broken, "/api/x")
    assert in_flight.requests == before


async def test_sockets_are_counted_while_open_and_not_after() -> None:
    opened = asyncio.Event()
    finish = asyncio.Event()

    async def socket_app(scope: Scope, receive: Receive, send: Send) -> None:
        opened.set()
        await finish.wait()

    async def nothing() -> dict:
        return {}

    async def ignore(message) -> None:
        return None

    before = in_flight.sockets
    task = asyncio.create_task(
        RequestTiming(socket_app)({"type": "websocket", "path": "/x"}, nothing, ignore)
    )
    await opened.wait()
    assert in_flight.sockets == before + 1
    finish.set()
    await task
    assert in_flight.sockets == before


async def test_a_frozen_app_and_open_connections_are_reported(caplog, monkeypatch) -> None:
    monkeypatch.setattr(in_flight, "sockets", 3)
    with caplog.at_level(logging.INFO, logger="uvicorn.error"):
        task = asyncio.create_task(watch(tick=0.01, stall=0.05, report_every=0.02))
        await asyncio.sleep(0.05)
        time.sleep(0.1)  # freezes the event loop, as blocking work would
        await asyncio.sleep(0.05)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    lines = [r.getMessage() for r in caplog.records]
    assert any(line.startswith("stall: the app froze") for line in lines)
    assert any(line.startswith("open: 3 live connections") for line in lines)


async def test_nothing_open_reports_nothing(caplog, monkeypatch) -> None:
    monkeypatch.setattr(in_flight, "sockets", 0)
    monkeypatch.setattr(in_flight, "requests", 0)
    with caplog.at_level(logging.INFO, logger="uvicorn.error"):
        task = asyncio.create_task(watch(tick=0.01, stall=5, report_every=0.02))
        await asyncio.sleep(0.06)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert not [r for r in caplog.records if r.getMessage().startswith("open:")]
