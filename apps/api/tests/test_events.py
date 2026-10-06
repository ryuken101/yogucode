"""Event ingestion: a child writes into their own trace, once, and nobody else's.

The subject boundary first, as everywhere a child writes. Then idempotency — the property
Phase 6's offline buffer will rely on — and the shape checks.
"""

import uuid
from datetime import UTC, datetime

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import Event
from app.models.base import new_uuid
from work_builders import open_first, today


def event(*, attempt_id=None, document_id=None, seq=0, type_="edit", payload=None, id_=None):
    return {
        "id": str(id_ or new_uuid()),
        "attempt_id": attempt_id,
        "document_id": document_id,
        "editor_session_id": "018f0000-0000-7000-8000-00000000e5e5",
        "seq": seq,
        "type": type_,
        "payload": payload
        if payload is not None
        else {"changes": [{"offset": 0, "length": 0, "text": "x"}]},
        "client_ts": datetime.now(UTC).isoformat(),
    }


async def post(client, events: list[dict]):
    return await client.post("/me/events", json={"events": events})


async def test_a_child_cannot_write_into_another_childs_trace(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student("Aria K")
    await today(client, session, aria)
    arias_attempt = (await open_first(client))["leaves"][0]["attempt"]["id"]
    arias_file = (await client.post("/me/documents", json={})).json()["id"]

    await signed_in_student("Bella N")
    assert (await post(client, [event(attempt_id=arias_attempt)])).status_code == 404
    assert (await post(client, [event(document_id=arias_file)])).status_code == 404
    assert (await session.exec(select(Event))).all() == []


async def test_one_foreign_target_refuses_the_whole_batch(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student("Aria K")
    await today(client, session, aria)
    arias_attempt = (await open_first(client))["leaves"][0]["attempt"]["id"]
    await signed_in_student("Bella N")
    bellas_file = (await client.post("/me/documents", json={})).json()["id"]

    response = await post(
        client, [event(document_id=bellas_file), event(attempt_id=arias_attempt, seq=1)]
    )
    assert response.status_code == 404
    assert (await session.exec(select(Event))).all() == []


async def test_a_teacher_cannot_post_events(client, signed_in) -> None:
    headers = await signed_in()
    response = await client.post("/me/events", json={"events": []}, headers=headers)
    assert response.status_code == 403


async def test_problem_and_file_events_are_both_recorded(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    await today(client, session, aria)
    attempt_id = (await open_first(client))["leaves"][0]["attempt"]["id"]
    file_id = (await client.post("/me/documents", json={})).json()["id"]

    response = await post(
        client,
        [
            event(attempt_id=attempt_id, seq=0),
            event(attempt_id=attempt_id, seq=1, type_="check", payload={"passed": 1, "total": 2}),
            event(document_id=file_id, seq=2, type_="run", payload={}),
        ],
    )

    assert response.status_code == 202
    rows = (await session.exec(select(Event).order_by(Event.seq))).all()
    assert [r.type for r in rows] == ["edit", "check", "run"]
    assert rows[0].attempt_id == uuid.UUID(attempt_id)
    assert rows[2].document_id == uuid.UUID(file_id)
    assert {r.student_id for r in rows} == {uuid.UUID(aria["student_id"])}


async def test_a_resent_batch_lands_once(client, session: AsyncSession, signed_in_student) -> None:
    """A dropped connection means the browser cannot know whether a batch arrived."""
    await signed_in_student()
    file_id = (await client.post("/me/documents", json={})).json()["id"]
    batch = [event(document_id=file_id, seq=n) for n in range(3)]

    await post(client, batch)
    again = await post(client, batch)

    assert again.status_code == 202
    assert len((await session.exec(select(Event))).all()) == 3


async def test_an_event_names_exactly_one_target(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    await today(client, session, aria)
    attempt_id = (await open_first(client))["leaves"][0]["attempt"]["id"]
    file_id = (await client.post("/me/documents", json={})).json()["id"]

    assert (await post(client, [event()])).status_code == 422
    both = event(attempt_id=attempt_id, document_id=file_id)
    assert (await post(client, [both])).status_code == 422


async def test_unknown_types_and_oversized_payloads_are_refused(
    client, session: AsyncSession, signed_in_student
) -> None:
    await signed_in_student()
    file_id = (await client.post("/me/documents", json={})).json()["id"]

    assert (await post(client, [event(document_id=file_id, type_="screenshot")])).status_code == 422
    huge = event(document_id=file_id, payload={"text": "x" * 70_000})
    assert (await post(client, [huge])).status_code == 422
    too_many = [event(document_id=file_id, seq=n) for n in range(501)]
    assert (await post(client, too_many)).status_code == 422
