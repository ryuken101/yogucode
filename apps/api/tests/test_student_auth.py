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


# --- usernames (Ken's decision, 11 Oct 2026) ---------------------------------------


async def test_the_username_is_case_insensitive(client, student_on_roster) -> None:
    roster = await student_on_roster()
    response = await client.post(
        "/auth/student/session",
        json={"username": f"  {roster['username'].upper()} ", "pin": roster["pin"]},
    )
    assert response.status_code == 200


async def test_a_child_in_no_class_is_told_to_ask_their_teacher(
    client, signed_in, session: AsyncSession
) -> None:
    """Said only after the right PIN, so it reveals nothing to someone guessing."""
    headers = await signed_in()
    child = (
        await client.post("/students", json={"display_name": "Chen W"}, headers=headers)
    ).json()
    response = await client.post(
        "/auth/student/session", json={"username": child["username"], "pin": child["pin"]}
    )
    assert response.status_code == 403
    assert "teacher" in response.json()["detail"]
    assert STUDENT_SESSION_COOKIE not in response.cookies
    assert (await session.exec(select(StudentSession))).all() == []


# --- signing in ---------------------------------------------------------------------


async def test_a_username_and_pin_sign_in(client, student_on_roster) -> None:
    roster = await student_on_roster()

    response = await client.post(
        "/auth/student/session",
        json={"username": roster["username"], "pin": roster["pin"]},
    )
    assert response.status_code == 200
    assert response.json()["display_name"] == "Aria K"
    assert response.json()["class_name"] == "Year 4-6 Python"
    assert STUDENT_SESSION_COOKIE in response.cookies


async def test_the_cookie_is_httponly_and_lax(client, student_on_roster) -> None:
    roster = await student_on_roster()
    response = await client.post(
        "/auth/student/session",
        json={"username": roster["username"], "pin": roster["pin"]},
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
        json={"username": roster["username"], "pin": roster["pin"]},
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


async def test_a_wrong_pin_is_refused(client, student_on_roster) -> None:
    roster = await student_on_roster()
    response = await client.post(
        "/auth/student/session",
        json={"username": roster["username"], "pin": WRONG_PIN},
    )
    assert response.status_code == 401
    assert STUDENT_SESSION_COOKIE not in response.cookies


async def test_a_wrong_pin_an_unknown_username_and_a_foreign_child_fail_alike(
    client, student_on_roster, foreign_centre
) -> None:
    """The route must not become an oracle for which children exist."""
    roster = await student_on_roster()
    attempts = [
        {"username": roster["username"], "pin": WRONG_PIN},
        {"username": "nobody.here", "pin": roster["pin"]},
        {"username": foreign_centre["student"].username, "pin": roster["pin"]},
    ]
    responses = [await client.post("/auth/student/session", json=body) for body in attempts]

    assert [r.status_code for r in responses] == [401, 401, 401]
    assert len({r.json()["detail"] for r in responses}) == 1


async def test_a_student_with_no_pin_cannot_sign_in(
    client, student_on_roster, session: AsyncSession
) -> None:
    roster = await student_on_roster()
    credential = await session.get(StudentCredential, uuid.UUID(roster["student_id"]))
    await session.delete(credential)
    await session.flush()

    response = await client.post(
        "/auth/student/session", json={"username": roster["username"], "pin": roster["pin"]}
    )
    assert response.status_code == 401


async def test_an_archived_student_cannot_sign_in(client, student_on_roster) -> None:
    """Straight off the phase plan's verification list."""
    roster = await student_on_roster()
    await client.post(f"/students/{roster['student_id']}/archive", headers=roster["headers"])

    response = await client.post(
        "/auth/student/session",
        json={"username": roster["username"], "pin": roster["pin"]},
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
    wrong = {"username": roster["username"], "pin": WRONG_PIN}

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
    wrong = {"username": roster["username"], "pin": WRONG_PIN}
    for _ in range(5):
        await client.post("/auth/student/session", json=wrong)

    right = await client.post(
        "/auth/student/session",
        json={"username": roster["username"], "pin": roster["pin"]},
    )
    assert right.status_code == 429


async def test_the_lock_releases_after_the_window(
    client, student_on_roster, session: AsyncSession
) -> None:
    roster = await student_on_roster()
    wrong = {"username": roster["username"], "pin": WRONG_PIN}
    for _ in range(5):
        await client.post("/auth/student/session", json=wrong)

    credential = await session.get(StudentCredential, uuid.UUID(roster["student_id"]))
    credential.locked_until = utcnow() - timedelta(seconds=1)
    session.add(credential)
    await session.flush()

    response = await client.post(
        "/auth/student/session",
        json={"username": roster["username"], "pin": roster["pin"]},
    )
    assert response.status_code == 200


async def test_a_correct_pin_clears_the_failure_count(
    client, student_on_roster, session: AsyncSession
) -> None:
    roster = await student_on_roster()
    wrong = {"username": roster["username"], "pin": WRONG_PIN}
    for _ in range(3):
        await client.post("/auth/student/session", json=wrong)

    await client.post(
        "/auth/student/session",
        json={"username": roster["username"], "pin": roster["pin"]},
    )
    credential = await session.get(StudentCredential, uuid.UUID(roster["student_id"]))
    assert credential.failed_attempts == 0
    assert credential.locked_until is None


async def test_lockout_is_audited_once_when_it_engages(
    client, student_on_roster, session: AsyncSession
) -> None:
    """Auditing every failure would flood the table; the lock is the signal."""
    roster = await student_on_roster()
    wrong = {"username": roster["username"], "pin": WRONG_PIN}
    for _ in range(5):
        await client.post("/auth/student/session", json=wrong)

    entries = (
        await session.exec(select(AuditLog).where(AuditLog.action == "student.locked_out"))
    ).all()
    assert len(entries) == 1


async def test_too_many_wrong_pins_from_one_device_blocks_it(
    client, student_on_roster, test_settings
) -> None:
    """With no class code in front, guessing across many usernames is stopped per device
    (IP). Only failures count, so a class signing in at once is never slowed."""
    test_settings.pin_failures_per_device = 3
    aria = await student_on_roster("Aria K")
    bella = await student_on_roster("Bella N", class_name="Other class")

    for username in ["aria.k", "bella.n", "nobody.at.all"]:
        await client.post("/auth/student/session", json={"username": username, "pin": WRONG_PIN})

    # Even the right PIN is refused from this device now — for any child.
    blocked = await client.post(
        "/auth/student/session", json={"username": bella["username"], "pin": bella["pin"]}
    )
    assert blocked.status_code == 429
    assert "computer" in blocked.json()["detail"]
    assert aria["username"] == "aria.k"


async def test_a_forged_forwarded_address_is_still_the_same_device(
    client, student_on_roster, test_settings, monkeypatch
) -> None:
    """Production trusts X-Forwarded-For for the scheme, and uvicorn then takes the
    leftmost address — the one a client writes. A new one per guess must not make each
    guess a new device (found 23 Oct 2026). On Fly the key is Fly-Client-IP."""
    monkeypatch.setenv("FLY_APP_NAME", "magikid-code")
    test_settings.pin_failures_per_device = 3
    await student_on_roster()
    for n in range(3):
        await client.post(
            "/auth/student/session",
            json={"username": "nobody.at.all", "pin": WRONG_PIN},
            headers={"X-Forwarded-For": f"10.0.0.{n}", "Fly-Client-IP": "203.0.113.7"},
        )
    blocked = await client.post(
        "/auth/student/session",
        json={"username": "nobody.at.all", "pin": WRONG_PIN},
        headers={"X-Forwarded-For": "10.9.9.9", "Fly-Client-IP": "203.0.113.7"},
    )
    assert blocked.status_code == 429


async def test_successful_sign_ins_do_not_count_against_the_device(
    client, student_on_roster, test_settings
) -> None:
    test_settings.pin_failures_per_device = 2
    roster = await student_on_roster()
    for _ in range(5):
        ok = await client.post(
            "/auth/student/session", json={"username": roster["username"], "pin": roster["pin"]}
        )
        assert ok.status_code == 200


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
    body = {"username": roster["username"], "pin": roster["pin"]}
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
        ("post", f"/students/{roster['student_id']}/pin", {}),
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
        json={"username": roster["username"], "pin": roster["pin"]},
    )
    cookie = response.headers["set-cookie"].lower()
    assert "student_session=" in cookie
    assert "max-age" not in cookie
    assert "expires" not in cookie
    assert "httponly" in cookie
