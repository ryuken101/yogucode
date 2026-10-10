"""The student's way in, end to end — and everything it must refuse.

The phase plan's verification list is the contract this file implements. These are the
tests that matter most in the repo after the tenancy ones: this is the only
unauthenticated surface in the API, and what is behind it is children's records.
"""

import uuid
from datetime import timedelta

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import STUDENT_SESSION_COOKIE
from app.models import AuditLog, Student, StudentCredential, StudentSession, StudentStatus
from app.models.base import utcnow

WRONG_PIN = "0000"  # weak, so the generator can never have issued it


# --- /join/lookup -------------------------------------------------------------------


async def test_a_code_returns_the_names_to_pick_from(client, student_on_roster) -> None:
    roster = await student_on_roster()

    response = await client.post("/join/lookup", json={"code": roster["code"]})
    assert response.status_code == 200
    body = response.json()
    assert body["class_name"] == "Year 4-6 Python"
    assert [s["display_name"] for s in body["students"]] == ["Aria K"]
    assert body["students"][0]["has_pin"] is True


async def test_lookup_returns_names_and_nothing_else(client, student_on_roster) -> None:
    """Anyone with the code sees this, so it must carry no more than the picker needs."""
    roster = await student_on_roster()

    body = (await client.post("/join/lookup", json={"code": roster["code"]})).json()
    assert set(body) == {"class_id", "class_name", "term_label", "students"}
    assert set(body["students"][0]) == {"id", "display_name", "has_pin"}
    serialised = str(body)
    assert roster["pin"] not in serialised
    assert "centre" not in serialised


async def test_a_student_without_a_pin_is_listed_but_flagged(
    client, signed_in, student_on_roster
) -> None:
    """The UI can say 'your teacher hasn't set your PIN yet' instead of just failing."""
    roster = await student_on_roster()
    headers = roster["headers"]
    late = (
        await client.post("/students", json={"display_name": "Bella N"}, headers=headers)
    ).json()
    await client.post(
        f"/classes/{roster['class_id']}/enrolments",
        json={"student_id": late["id"]},
        headers=headers,
    )

    body = (await client.post("/join/lookup", json={"code": roster["code"]})).json()
    flags = {s["display_name"]: s["has_pin"] for s in body["students"]}
    assert flags == {"Aria K": True, "Bella N": False}


async def test_lookup_is_case_insensitive(client, student_on_roster) -> None:
    roster = await student_on_roster()
    response = await client.post("/join/lookup", json={"code": roster["code"].lower()})
    assert response.status_code == 200


async def test_an_unknown_code_is_404(client) -> None:
    assert (await client.post("/join/lookup", json={"code": "ZZZZZZ"})).status_code == 404


async def test_a_rotated_code_stops_working(client, student_on_roster) -> None:
    roster = await student_on_roster()
    await client.post(f"/classes/{roster['class_id']}/join-code/rotate", headers=roster["headers"])

    assert (await client.post("/join/lookup", json={"code": roster["code"]})).status_code == 404


async def test_an_archived_classs_code_stops_working(client, student_on_roster) -> None:
    roster = await student_on_roster()
    await client.post(f"/classes/{roster['class_id']}/archive", headers=roster["headers"])

    assert (await client.post("/join/lookup", json={"code": roster["code"]})).status_code == 404


async def test_a_withdrawn_student_is_not_on_the_picker(client, student_on_roster) -> None:
    roster = await student_on_roster()
    await client.post(
        f"/classes/{roster['class_id']}/enrolments/{roster['student_id']}/withdraw",
        headers=roster["headers"],
    )

    body = (await client.post("/join/lookup", json={"code": roster["code"]})).json()
    assert body["students"] == []


# --- signing in ---------------------------------------------------------------------


async def test_a_name_and_pin_behind_a_code_signs_in(client, student_on_roster) -> None:
    roster = await student_on_roster()

    response = await client.post(
        "/auth/student/session",
        json={"code": roster["code"], "student_id": roster["student_id"], "pin": roster["pin"]},
    )
    assert response.status_code == 200
    assert response.json()["display_name"] == "Aria K"
    assert response.json()["class_name"] == "Year 4-6 Python"
    assert STUDENT_SESSION_COOKIE in response.cookies


async def test_the_cookie_is_httponly_and_lax(client, student_on_roster) -> None:
    roster = await student_on_roster()
    response = await client.post(
        "/auth/student/session",
        json={"code": roster["code"], "student_id": roster["student_id"], "pin": roster["pin"]},
    )

    header = response.headers["set-cookie"].lower()
    assert "httponly" in header
    assert "samesite=lax" in header
    assert "path=/" in header


async def test_only_the_hash_of_the_token_is_stored(
    client, student_on_roster, session: AsyncSession
) -> None:
    roster = await student_on_roster()
    response = await client.post(
        "/auth/student/session",
        json={"code": roster["code"], "student_id": roster["student_id"], "pin": roster["pin"]},
    )
    token = response.cookies[STUDENT_SESSION_COOKIE]

    stored = (await session.exec(select(StudentSession))).one()
    assert stored.token_hash != token
    assert token not in stored.token_hash


async def test_the_session_reaches_a_student_route(client, signed_in_student) -> None:
    """The round trip the Secure-cookie setting exists to make possible."""
    await signed_in_student()

    me = await client.get("/auth/student/me")
    assert me.status_code == 200
    assert me.json()["display_name"] == "Aria K"


async def test_signing_in_needs_the_code_as_well(client, student_on_roster) -> None:
    """Defence in depth: a roster id and a PIN are not enough on their own."""
    roster = await student_on_roster()

    response = await client.post(
        "/auth/student/session",
        json={"code": "ZZZZZZ", "student_id": roster["student_id"], "pin": roster["pin"]},
    )
    assert response.status_code == 404
    assert STUDENT_SESSION_COOKIE not in response.cookies


async def test_a_wrong_pin_is_refused(client, student_on_roster) -> None:
    roster = await student_on_roster()
    response = await client.post(
        "/auth/student/session",
        json={"code": roster["code"], "student_id": roster["student_id"], "pin": WRONG_PIN},
    )
    assert response.status_code == 401
    assert STUDENT_SESSION_COOKIE not in response.cookies


async def test_a_wrong_pin_an_unknown_id_and_a_foreign_child_fail_alike(
    client, student_on_roster, foreign_centre
) -> None:
    """The route must not become an oracle for which children exist."""
    roster = await student_on_roster()
    attempts = [
        {"code": roster["code"], "student_id": roster["student_id"], "pin": WRONG_PIN},
        {"code": roster["code"], "student_id": str(uuid.uuid4()), "pin": roster["pin"]},
        {
            "code": roster["code"],
            "student_id": str(foreign_centre["student"].id),
            "pin": roster["pin"],
        },
    ]
    responses = [await client.post("/auth/student/session", json=body) for body in attempts]

    assert [r.status_code for r in responses] == [401, 401, 401]
    assert len({r.json()["detail"] for r in responses}) == 1


async def test_a_student_with_no_pin_cannot_sign_in(client, signed_in, student_on_roster) -> None:
    roster = await student_on_roster()
    headers = roster["headers"]
    late = (
        await client.post("/students", json={"display_name": "Bella N"}, headers=headers)
    ).json()
    await client.post(
        f"/classes/{roster['class_id']}/enrolments",
        json={"student_id": late["id"]},
        headers=headers,
    )

    response = await client.post(
        "/auth/student/session",
        json={"code": roster["code"], "student_id": late["id"], "pin": "4827"},
    )
    assert response.status_code == 401


async def test_an_archived_student_cannot_sign_in(client, student_on_roster) -> None:
    """Straight off the phase plan's verification list."""
    roster = await student_on_roster()
    await client.post(f"/students/{roster['student_id']}/archive", headers=roster["headers"])

    response = await client.post(
        "/auth/student/session",
        json={"code": roster["code"], "student_id": roster["student_id"], "pin": roster["pin"]},
    )
    assert response.status_code == 401


async def test_signing_in_is_audited(client, signed_in_student, session: AsyncSession) -> None:
    await signed_in_student()

    entry = (
        await session.exec(select(AuditLog).where(AuditLog.action == "student.signed_in"))
    ).one()
    assert entry.actor_type == "student"
    assert entry.target_type == "student"


# --- lockout ------------------------------------------------------------------------


async def test_five_wrong_pins_lock_the_account(
    client, student_on_roster, session: AsyncSession
) -> None:
    roster = await student_on_roster()
    wrong = {"code": roster["code"], "student_id": roster["student_id"], "pin": WRONG_PIN}

    for _ in range(5):
        assert (await client.post("/auth/student/session", json=wrong)).status_code == 401

    # The counter is committed before each refusal is raised; otherwise the fifth wrong
    # PIN would roll back with the 401 and nothing would ever lock.
    credential = await session.get(StudentCredential, uuid.UUID(roster["student_id"]))
    assert credential.locked_until is not None

    locked = await client.post("/auth/student/session", json=wrong)
    assert locked.status_code == 429
    assert "teacher" in locked.json()["detail"]


async def test_the_right_pin_is_refused_while_locked(client, student_on_roster) -> None:
    roster = await student_on_roster()
    wrong = {"code": roster["code"], "student_id": roster["student_id"], "pin": WRONG_PIN}
    for _ in range(5):
        await client.post("/auth/student/session", json=wrong)

    right = await client.post(
        "/auth/student/session",
        json={"code": roster["code"], "student_id": roster["student_id"], "pin": roster["pin"]},
    )
    assert right.status_code == 429


async def test_the_lock_releases_after_the_window(
    client, student_on_roster, session: AsyncSession
) -> None:
    roster = await student_on_roster()
    wrong = {"code": roster["code"], "student_id": roster["student_id"], "pin": WRONG_PIN}
    for _ in range(5):
        await client.post("/auth/student/session", json=wrong)

    credential = await session.get(StudentCredential, uuid.UUID(roster["student_id"]))
    credential.locked_until = utcnow() - timedelta(seconds=1)
    session.add(credential)
    await session.flush()

    response = await client.post(
        "/auth/student/session",
        json={"code": roster["code"], "student_id": roster["student_id"], "pin": roster["pin"]},
    )
    assert response.status_code == 200


async def test_a_correct_pin_clears_the_failure_count(
    client, student_on_roster, session: AsyncSession
) -> None:
    roster = await student_on_roster()
    wrong = {"code": roster["code"], "student_id": roster["student_id"], "pin": WRONG_PIN}
    for _ in range(3):
        await client.post("/auth/student/session", json=wrong)

    await client.post(
        "/auth/student/session",
        json={"code": roster["code"], "student_id": roster["student_id"], "pin": roster["pin"]},
    )
    credential = await session.get(StudentCredential, uuid.UUID(roster["student_id"]))
    assert credential.failed_attempts == 0
    assert credential.locked_until is None


async def test_lockout_is_audited_once_when_it_engages(
    client, student_on_roster, session: AsyncSession
) -> None:
    """Auditing every failure would flood the table; the lock is the signal."""
    roster = await student_on_roster()
    wrong = {"code": roster["code"], "student_id": roster["student_id"], "pin": WRONG_PIN}
    for _ in range(5):
        await client.post("/auth/student/session", json=wrong)

    entries = (
        await session.exec(select(AuditLog).where(AuditLog.action == "student.locked_out"))
    ).all()
    assert len(entries) == 1


# --- sessions -----------------------------------------------------------------------


async def test_a_revoked_session_is_rejected_on_the_next_request(client, signed_in_student) -> None:
    """The reason the token is opaque rather than a JWT."""
    roster = await signed_in_student()
    assert (await client.get("/auth/student/me")).status_code == 200

    await client.post(
        f"/students/{roster['student_id']}/sessions/revoke", headers=roster["headers"]
    )
    assert (await client.get("/auth/student/me")).status_code == 401


async def test_the_kick_reports_what_it_revoked(client, signed_in_student) -> None:
    roster = await signed_in_student()
    response = await client.post(
        f"/students/{roster['student_id']}/sessions/revoke", headers=roster["headers"]
    )
    assert response.json() == {"student_id": roster["student_id"], "revoked": 1}


async def test_archiving_a_student_signs_them_out(client, signed_in_student) -> None:
    roster = await signed_in_student()
    await client.post(f"/students/{roster['student_id']}/archive", headers=roster["headers"])

    assert (await client.get("/auth/student/me")).status_code == 401


async def test_signing_in_again_ends_the_first_session(client, student_on_roster) -> None:
    roster = await student_on_roster()
    body = {
        "code": roster["code"],
        "student_id": roster["student_id"],
        "pin": roster["pin"],
    }
    first = await client.post("/auth/student/session", json=body)
    first_token = first.cookies[STUDENT_SESSION_COOKIE]
    second = await client.post("/auth/student/session", json=body)
    second_token = second.cookies[STUDENT_SESSION_COOKIE]
    assert first_token != second_token

    client.cookies.set(STUDENT_SESSION_COOKIE, first_token)
    assert (await client.get("/auth/student/me")).status_code == 401

    client.cookies.set(STUDENT_SESSION_COOKIE, second_token)
    assert (await client.get("/auth/student/me")).status_code == 200


async def test_logout_ends_the_session(client, signed_in_student) -> None:
    await signed_in_student()
    assert (await client.post("/auth/student/logout")).status_code == 204
    assert (await client.get("/auth/student/me")).status_code == 401


async def test_logout_twice_is_not_an_error(client, signed_in_student) -> None:
    await signed_in_student()
    await client.post("/auth/student/logout")
    assert (await client.post("/auth/student/logout")).status_code == 204


async def test_an_expired_session_is_rejected(
    client, signed_in_student, session: AsyncSession
) -> None:
    await signed_in_student()
    record = (await session.exec(select(StudentSession))).one()
    record.expires_at = utcnow() - timedelta(seconds=1)
    session.add(record)
    await session.flush()

    assert (await client.get("/auth/student/me")).status_code == 401


async def test_an_idle_session_is_rejected(
    client, signed_in_student, session: AsyncSession, test_settings
) -> None:
    """Independent of the absolute clock: an abandoned laptop logs itself out."""
    await signed_in_student()
    record = (await session.exec(select(StudentSession))).one()
    record.last_seen_at = utcnow() - timedelta(
        minutes=test_settings.student_session_idle_minutes + 1
    )
    session.add(record)
    await session.flush()

    assert record.expires_at > utcnow()
    assert (await client.get("/auth/student/me")).status_code == 401


async def test_a_made_up_cookie_is_not_a_way_in(client) -> None:
    client.cookies.set(STUDENT_SESSION_COOKIE, "not-a-real-token")
    assert (await client.get("/auth/student/me")).status_code == 401


# --- what a student must never reach ------------------------------------------------


async def test_a_signed_in_student_cannot_list_the_roster(client, signed_in_student) -> None:
    """The phase plan is explicit: a student cannot list the roster."""
    roster = await signed_in_student()
    response = await client.get(f"/classes/{roster['class_id']}/roster")
    assert response.status_code == 403


async def test_a_signed_in_student_cannot_reach_teacher_routes(client, signed_in_student) -> None:
    roster = await signed_in_student()
    calls = [
        ("get", "/classes", None),
        ("post", "/classes", {"name": "Mine now"}),
        ("get", f"/classes/{roster['class_id']}", None),
        ("get", "/students", None),
        ("post", "/students", {"display_name": "Ghost"}),
        ("get", f"/students/{roster['student_id']}", None),
        ("get", "/centre", None),
        ("get", "/auth/me", None),
        ("post", f"/classes/{roster['class_id']}/join-code/rotate", None),
        ("post", f"/classes/{roster['class_id']}/pins", {"reset_existing": True}),
        ("post", f"/students/{roster['student_id']}/pin/reset", None),
        ("post", f"/students/{roster['student_id']}/sessions/revoke", None),
        ("post", f"/classes/{roster['class_id']}/roster/preview", {"names": "Ghost"}),
    ]
    for method, path, payload in calls:
        response = await client.request(method, path, json=payload)
        assert response.status_code == 403, f"{method} {path} returned {response.status_code}"


async def test_a_student_sees_only_their_own_class(client, signed_in_student) -> None:
    roster = await signed_in_student()
    me = (await client.get("/auth/student/me")).json()
    assert me["class_id"] == roster["class_id"]
    assert me["student_id"] == roster["student_id"]


async def test_a_teacher_token_does_not_satisfy_a_student_route(client, signed_in) -> None:
    headers = await signed_in()
    assert (await client.get("/auth/student/me", headers=headers)).status_code == 403


async def test_the_student_principal_carries_the_centre(
    client, signed_in_student, session: AsyncSession
) -> None:
    """student_sessions has no centre_id, so the Principal's has to come via students."""
    roster = await signed_in_student()
    student = await session.get(Student, uuid.UUID(roster["student_id"]))
    assert student.centre_id is not None
    assert student.status == StudentStatus.ACTIVE
    assert (await client.get("/auth/student/me")).status_code == 200


async def test_the_session_cookie_ends_with_the_browser(client, student_on_roster) -> None:
    """No Max-Age or Expires: quitting the browser drops it (closing the app = sign in again).

    The server's own absolute and idle limits still apply on top.
    """
    roster = await student_on_roster()
    response = await client.post(
        "/auth/student/session",
        json={"code": roster["code"], "student_id": roster["student_id"], "pin": roster["pin"]},
    )
    cookie = response.headers["set-cookie"].lower()
    assert "student_session=" in cookie
    assert "max-age" not in cookie
    assert "expires" not in cookie
    assert "httponly" in cookie
