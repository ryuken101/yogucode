"""The request-size cap and validation errors that don't repeat what was sent
(`app/limits.py`, found in the 23 Oct 2026 test run)."""


async def test_an_oversized_body_is_refused_before_anything_reads_it(client) -> None:
    big = '{"username":"x","pin":"' + "1" * (3 * 1024 * 1024) + '"}'
    response = await client.post(
        "/auth/student/session", content=big, headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 413


async def test_a_validation_error_does_not_echo_the_input(client) -> None:
    response = await client.post(
        "/auth/student/session", json={"username": "x", "pin": "SECRET-ish" * 100}
    )
    assert response.status_code == 422
    assert "SECRET-ish" not in response.text
    assert response.json()["detail"][0]["loc"]


async def test_a_file_name_is_a_name_not_a_path(client, signed_in_student) -> None:
    await signed_in_student()
    response = await client.post("/me/documents", json={"title": "../../etc/passwd"})
    assert response.status_code == 422
    assert "/" in response.json()["detail"][0]["msg"]
