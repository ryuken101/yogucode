"""Production: one app serving the website and the API from one address.

Ken's decision (10 Oct 2026): host everything as one app on Fly.io rather than the website
on Vercel and the API on Fly. One origin means the child's session cookie (SameSite=Lax)
and the live classroom's WebSockets just work, there is no CORS to configure, and there is
no second service or domain to pay for.

    uvicorn app.server:site      # production (the Dockerfile)
    uvicorn app.main:app         # development, behind Vite's /api proxy

The API is mounted under `/api` — exactly the prefix the web app already uses, which in
development Vite strips before proxying. Routers, tests and the OpenAPI schema are all
about `app.main:app` and are unchanged by this file.

Every response carries the **cross-origin isolation headers** (`COOP: same-origin`,
`COEP: require-corp`), the same ones `vite.config.ts` sets in development. Without them
`SharedArrayBuffer` does not exist, Python's `input()` hangs and Stop does nothing — the
editor detects that and refuses to run, so a missing header is a broken product.
"""

import mimetypes
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.main import app as api

# Not every slim image's mimetypes table knows these, and a .wasm served as
# application/octet-stream fails Pyodide's streaming compile.
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".mjs")

ISOLATION_HEADERS = [
    (b"cross-origin-opener-policy", b"same-origin"),
    (b"cross-origin-embedder-policy", b"require-corp"),
]

# Hashed build output and the pinned Pyodide copy never change under the same name, so
# browsers may keep them for a year — a class's 5.7 MB Python download happens once.
# index.html must never be cached, or a deploy would not reach anyone.
IMMUTABLE = "public, max-age=31536000, immutable"
NO_CACHE = "no-cache"


def web_dist() -> Path:
    """Where the built website is: WEB_DIST, else the monorepo's apps/web/dist."""
    configured = os.getenv("WEB_DIST")
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parents[3] / "web" / "dist"


class IsolationHeaders:
    """Add the cross-origin isolation headers to every HTTP response."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = [
                    (k, v)
                    for k, v in message.get("headers", [])
                    if k not in {name for name, _ in ISOLATION_HEADERS}
                ]
                message["headers"] = headers + ISOLATION_HEADERS
            await send(message)

        await self.app(scope, receive, with_headers)


def create_site(dist: Path | None = None) -> FastAPI:
    root = (dist or web_dist()).resolve()
    site = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    site.mount("/api", api)

    # HEAD as well as GET: uptime monitors and some link checkers only ask for headers.
    @site.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def website(path: str) -> FileResponse:
        """A built file if there is one; otherwise index.html, so client routes work.

        `/classes/…`, `/quiz/…` and the rest are React Router paths with no file behind
        them: a refresh or a typed address must still load the app.
        """
        if not (root / "index.html").is_file():
            raise HTTPException(status_code=503, detail="the website has not been built")
        candidate = (root / path).resolve()
        # Resolved and checked, so `..` cannot walk out of the build directory.
        if path and candidate.is_file() and candidate.is_relative_to(root):
            immutable = path.startswith(("assets/", "pyodide/"))
            return FileResponse(
                candidate, headers={"Cache-Control": IMMUTABLE if immutable else NO_CACHE}
            )
        return FileResponse(root / "index.html", headers={"Cache-Control": NO_CACHE})

    site.add_middleware(IsolationHeaders)
    return site


site = create_site()
