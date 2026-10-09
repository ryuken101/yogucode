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

**One address** (Ken's decision, 10 Oct 2026: yogucode.com). `www.yogucode.com` and the
old `magikid-code.fly.dev` answer with a 308 to it rather than serving the app. A child's
session cookie and a teacher's Supabase session both belong to one host, so a class
split across two addresses would see people "signed out" at random. Only the hosts listed
in `REDIRECT_HOSTS` redirect: Fly's health check, local development and tests reach the
app by other names and are untouched.
"""

import mimetypes
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from starlette.datastructures import Headers
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


class CanonicalHost:
    """308 any HTTP request for a listed host to the same path on the canonical host.

    308 rather than 301 so a POST stays a POST. WebSockets are left alone: they only ever
    open from a page that is already on the canonical host.
    """

    def __init__(self, app: ASGIApp, canonical: str, redirect_hosts: frozenset[str]) -> None:
        self.app = app
        self.canonical = canonical
        self.redirect_hosts = redirect_hosts

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and self.redirect_hosts:
            host = Headers(scope=scope).get("host", "").split(":")[0].lower()
            if host in self.redirect_hosts:
                # The host is fixed, so no path (not even `//evil.example`) can send
                # anyone off this site.
                path = (scope.get("raw_path") or scope["path"].encode()).decode("latin-1")
                target = f"https://{self.canonical}{path}"
                if scope.get("query_string"):
                    target += "?" + scope["query_string"].decode()
                await send(
                    {
                        "type": "http.response.start",
                        "status": 308,
                        "headers": [(b"location", target.encode()), (b"content-length", b"0")],
                    }
                )
                await send({"type": "http.response.body", "body": b""})
                return
        await self.app(scope, receive, send)


def host_list(value: str | None) -> frozenset[str]:
    return frozenset(h.strip().lower() for h in (value or "").split(",") if h.strip())


def create_site(
    dist: Path | None = None,
    canonical_host: str | None = None,
    redirect_hosts: str | None = None,
) -> FastAPI:
    """The production app. Host settings default to CANONICAL_HOST and REDIRECT_HOSTS."""
    root = (dist or web_dist()).resolve()
    if canonical_host is None:
        canonical_host = os.getenv("CANONICAL_HOST", "")
    if redirect_hosts is None:
        redirect_hosts = os.getenv("REDIRECT_HOSTS", "")
    canonical, redirects = canonical_host.strip().lower(), host_list(redirect_hosts)
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

    if canonical and redirects:
        site.add_middleware(CanonicalHost, canonical=canonical, redirect_hosts=redirects)
    # Added last, so it is outermost: redirects carry the isolation headers too.
    site.add_middleware(IsolationHeaders)
    return site


site = create_site()
