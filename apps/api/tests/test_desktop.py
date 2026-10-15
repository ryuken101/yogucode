"""A teacher's saved desktop layout (16 Oct 2026): `GET` / `PUT /me/desktop`.

It is the teacher's own and follows them between laptops; another teacher never sees it,
students have none, and the shape is checked so a bad save cannot store junk.
"""

from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import DesktopLayout
from app.routers.desktop import MAX_WINDOWS

URL = "/me/desktop"

LIVE = {"app": "live", "path": "/classes/abc/live", "x": 0, "y": 0, "w": 0.56, "h": 1, "z": 3}
CODE = {"app": "code", "path": "/my-code", "x": 0.56, "y": 0, "w": 0.44, "h": 1, "z": 4}


async def test_nothing_saved_yet(client, signed_in) -> None:
    ken = await signed_in()
    body = (await client.get(URL, headers=ken)).json()
    assert body == {"windows": [], "class_id": None, "saved": False}


async def test_save_then_load(client, signed_in) -> None:
    ken = await signed_in()
    saved = await client.put(URL, json={"windows": [LIVE, CODE], "class_id": "abc"}, headers=ken)
    assert saved.status_code == 200, saved.text
    body = (await client.get(URL, headers=ken)).json()
    assert body["saved"] is True and body["class_id"] == "abc"
    assert [w["app"] for w in body["windows"]] == ["live", "code"]
    assert body["windows"][0]["w"] == 0.56


async def test_a_save_replaces_the_last(client, signed_in, session: AsyncSession) -> None:
    ken = await signed_in()
    await client.put(URL, json={"windows": [LIVE, CODE]}, headers=ken)
    await client.put(URL, json={"windows": [CODE]}, headers=ken)
    assert [w["app"] for w in (await client.get(URL, headers=ken)).json()["windows"]] == ["code"]
    assert len((await session.exec(DesktopLayout.__table__.select())).all()) == 1


async def test_another_teacher_has_their_own(client, signed_in) -> None:
    ken = await signed_in()
    await client.put(URL, json={"windows": [LIVE]}, headers=ken)
    mia = await signed_in("mia@example.com")
    assert (await client.get(URL, headers=mia)).json()["saved"] is False


async def test_a_bad_shape_is_refused(client, signed_in) -> None:
    ken = await signed_in()
    for window in (
        {**LIVE, "path": "https://evil.example/"},
        {**LIVE, "w": 0},
        {**LIVE, "app": "Live App!"},
    ):
        response = await client.put(URL, json={"windows": [window]}, headers=ken)
        assert response.status_code == 422, window
    too_many = [{**CODE, "z": i} for i in range(MAX_WINDOWS + 1)]
    assert (await client.put(URL, json={"windows": too_many}, headers=ken)).status_code == 422


async def test_students_have_no_desktop_to_save(client, signed_in_student) -> None:
    await signed_in_student()
    assert (await client.get(URL)).status_code in (401, 403)
    assert (await client.put(URL, json={"windows": []})).status_code in (401, 403)
