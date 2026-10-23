"""Two guards on what a request may cost (found in the 23 Oct 2026 test run).

- **A cap on request bodies.** Nothing here legitimately sends more than a few hundred
  kilobytes: a child's file is at most 64 KB, a problem import is a handful of YAML files.
  Without a cap a 20 MB body was read in full before validation refused it, and anyone with
  a session could do that in a loop.
- **Validation errors that don't repeat the input.** FastAPI's default 422 includes each
  offending value, so that same 20 MB came straight back in the error. The message, the
  location and the limits stay; the value goes.
"""

from fastapi import Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

MAX_BODY_BYTES = 2 * 1024 * 1024


async def _too_large(send: Send) -> None:
    body = b'{"detail":"That is too big to send."}'
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


class BodySizeLimit:
    """Refuse a body over `max_bytes` with 413, before any route reads it.

    A declared Content-Length is checked up front. A body without one (chunked) is read
    here, up to the limit, and handed on only if it fits.
    """

    def __init__(self, app: ASGIApp, max_bytes: int = MAX_BODY_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        declared = Headers(scope=scope).get("content-length")
        if declared is not None:
            if declared.isdigit() and int(declared) > self.max_bytes:
                await _too_large(send)
                return
            await self.app(scope, receive, send)
            return

        buffered: list[Message] = []
        size = 0
        while True:
            message = await receive()
            buffered.append(message)
            if message["type"] != "http.request":
                break
            size += len(message.get("body", b""))
            if size > self.max_bytes:
                await _too_large(send)
                return
            if not message.get("more_body", False):
                break

        async def replay() -> Message:
            return buffered.pop(0) if buffered else await receive()

        await self.app(scope, replay, send)


async def validation_error(_request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)
    errors = [{k: v for k, v in e.items() if k != "input"} for e in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})
