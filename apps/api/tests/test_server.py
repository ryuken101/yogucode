"""The production app: the website and the API from one address (app/server.py).

The one thing that must never regress is the cross-origin isolation headers. Without them
the browser has no SharedArrayBuffer, and Python in the editor cannot take input or be
stopped — the editor refuses to run at all.
"""

from pathlib import Path

import httpx
import pytest

from app.server import create_site


@pytest.fixture
def dist(tmp_path: Path) -> Path:
    (tmp_path / "assets").mkdir()
    (tmp_path / "pyodide").mkdir()
    (tmp_path / "index.html").write_text("<!doctype html><title>app</title>")
    (tmp_path / "assets" / "index-abc123.js").write_text("console.log(1)")
    (tmp_path / "pyodide" / "pyodide.asm.wasm").write_bytes(b"\0asm")
    (tmp_path.parent / "secret.txt").write_text("not for the web")
    return tmp_path


async def get(site, path: str) -> httpx.Response:
    transport = httpx.ASGITransport(app=site)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get(path)


def isolated(response: httpx.Response) -> bool:
    return (
        response.headers.get("cross-origin-opener-policy") == "same-origin"
        and response.headers.get("cross-origin-embedder-policy") == "require-corp"
    )


async def test_every_response_is_cross_origin_isolated(dist: Path) -> None:
    site = create_site(dist)
    for path in ["/", "/classes/123", "/assets/index-abc123.js", "/api/health"]:
        response = await get(site, path)
        assert response.status_code == 200, path
        assert isolated(response), path


async def test_client_routes_load_the_app(dist: Path) -> None:
    site = create_site(dist)
    for path in ["/", "/quiz/018f0000-0000-7000-8000-000000000001", "/classes/x/live", "/join"]:
        response = await get(site, path)
        assert "<title>app</title>" in response.text, path
        assert response.headers["cache-control"] == "no-cache", "index.html must never be cached"


async def test_built_files_are_cached_for_a_year(dist: Path) -> None:
    site = create_site(dist)
    asset = await get(site, "/assets/index-abc123.js")
    assert asset.text == "console.log(1)"
    assert "immutable" in asset.headers["cache-control"]
    wasm = await get(site, "/pyodide/pyodide.asm.wasm")
    assert wasm.headers["content-type"] == "application/wasm"
    assert "immutable" in wasm.headers["cache-control"]


async def test_the_api_lives_under_api(dist: Path) -> None:
    site = create_site(dist)
    assert (await get(site, "/api/health")).json() == {"status": "ok"}
    assert (await get(site, "/api/classes")).status_code == 401, "auth still applies"


async def test_nothing_outside_the_build_is_served(dist: Path) -> None:
    site = create_site(dist)
    response = await get(site, "/../secret.txt")
    assert "not for the web" not in response.text
    response = await get(site, "/%2e%2e/secret.txt")
    assert "not for the web" not in response.text


async def test_a_missing_build_says_so_but_the_api_still_answers(tmp_path: Path) -> None:
    site = create_site(tmp_path / "nowhere")
    assert (await get(site, "/")).status_code == 503
    assert (await get(site, "/api/health")).status_code == 200


async def test_a_head_request_is_answered(dist: Path) -> None:
    """Uptime monitors check with HEAD; a 405 would read as the site being down."""
    transport = httpx.ASGITransport(app=create_site(dist))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.head("/")
    assert response.status_code == 200
    assert isolated(response)


def on_domain(dist: Path):
    return create_site(
        dist,
        canonical_host="yogucode.com",
        redirect_hosts="www.yogucode.com, magikid-code.fly.dev",
    )


async def get_as(site, host: str, path: str) -> httpx.Response:
    transport = httpx.ASGITransport(app=site)
    async with httpx.AsyncClient(transport=transport, base_url=f"http://{host}") as client:
        return await client.get(path)


async def test_www_and_the_old_address_redirect_to_the_one_address(dist: Path) -> None:
    """One host, because a child's cookie and a teacher's session both belong to one."""
    site = on_domain(dist)
    for host in ["www.yogucode.com", "magikid-code.fly.dev", "WWW.YOGUCODE.COM:443"]:
        response = await get_as(site, host, "/classes/123?tab=roster")
        assert response.status_code == 308, host
        assert response.headers["location"] == "https://yogucode.com/classes/123?tab=roster"
        assert isolated(response), "redirects carry the isolation headers too"


async def test_a_post_is_redirected_as_a_post(dist: Path) -> None:
    transport = httpx.ASGITransport(app=on_domain(dist))
    async with httpx.AsyncClient(transport=transport, base_url="http://www.yogucode.com") as c:
        response = await c.post("/api/auth/student/session", json={"username": "x", "pin": "1"})
    assert response.status_code == 308, "308, not 301: a POST must not become a GET"


async def test_a_redirect_cannot_leave_the_site(dist: Path) -> None:
    response = await get_as(on_domain(dist), "www.yogucode.com", "//evil.example/x")
    assert response.headers["location"].startswith("https://yogucode.com/")


async def test_the_canonical_host_and_unlisted_hosts_are_served(dist: Path) -> None:
    """Fly's health check reaches the machine by its private address, not by name."""
    site = on_domain(dist)
    for host in ["yogucode.com", "172.19.0.2:8080", "localhost"]:
        assert (await get_as(site, host, "/")).status_code == 200, host
        assert (await get_as(site, host, "/api/health")).json() == {"status": "ok"}, host


async def test_no_redirect_without_a_canonical_host(dist: Path) -> None:
    site = create_site(dist, canonical_host="", redirect_hosts="www.yogucode.com")
    assert (await get_as(site, "www.yogucode.com", "/")).status_code == 200
