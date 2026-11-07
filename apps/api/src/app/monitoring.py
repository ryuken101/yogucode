"""What the hosting charts can't show, in the logs (7 Nov 2026).

Fly's charts showed long waits and connections near the limit, but not why. These lines
separate the possible causes:

- **Slow requests** are timed inside the app. A long wait on Fly's chart with no line here
  was spent queueing before the request reached the app.
- **Stalls** are the event loop waking late: the whole app froze, whatever it was serving.
- **Open connections** are every socket the app is holding. More sockets than people in the
  hub's rooms means connections are leaking.

Paths have their ids removed, and nothing here logs a name, a username or any code.
"""

import asyncio
import contextlib
import logging
import re
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.live.hub import hub

# uvicorn's logger, the one configured to reach Fly's logs at INFO.
log = logging.getLogger("uvicorn.error")

SLOW_REQUEST_SECONDS = 2.0
STALL_SECONDS = 1.0
REPORT_EVERY_SECONDS = 60.0

_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


@dataclass
class InFlight:
    requests: int = 0
    sockets: int = 0


in_flight = InFlight()


def route_of(path: str) -> str:
    """The path with its ids removed, and cut short: it can be anything a visitor typed."""
    return _UUID.sub(":id", path)[:100]


class RequestTiming:
    """Count what is open, and log any HTTP request slower than `SLOW_REQUEST_SECONDS`."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "websocket":
            in_flight.sockets += 1
            try:
                await self.app(scope, receive, send)
            finally:
                in_flight.sockets -= 1
            return
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        status: int | None = None

        async def noting_status(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        started = time.monotonic()
        in_flight.requests += 1
        try:
            await self.app(scope, receive, noting_status)
        finally:
            in_flight.requests -= 1
            took = time.monotonic() - started
            if took >= SLOW_REQUEST_SECONDS:
                log.warning(
                    "slow request: %s %r %s took %.1fs",
                    scope["method"],
                    route_of(scope["path"]),
                    status,
                    took,
                )


async def watch(
    tick: float = 1.0, stall: float = STALL_SECONDS, report_every: float = REPORT_EVERY_SECONDS
) -> None:
    """Report stalls straight away, and what is open once a minute while anything is."""
    since_report = 0.0
    while True:
        started = time.monotonic()
        await asyncio.sleep(tick)
        elapsed = time.monotonic() - started
        if elapsed - tick >= stall:
            log.warning("stall: the app froze for %.1fs", elapsed - tick)
        since_report += elapsed
        if since_report >= report_every:
            since_report = 0.0
            if in_flight.sockets or in_flight.requests:
                children, teachers = hub.in_rooms()
                log.info(
                    "open: %d live connections (%d children, %d teachers in rooms), %d requests",
                    in_flight.sockets,
                    children,
                    teachers,
                    in_flight.requests,
                )


@contextlib.asynccontextmanager
async def monitor_loop() -> AsyncIterator[None]:
    task = asyncio.create_task(watch())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
