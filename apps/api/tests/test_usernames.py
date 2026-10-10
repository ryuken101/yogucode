"""Student usernames (Ken's decision, 11 Oct 2026): suggested from the name, editable,
unique everywhere, case-insensitive."""

from app.usernames import base_username, suggest_username


def test_a_username_is_suggested_from_the_name() -> None:
    assert base_username("Aria Kim") == "aria.k"
    assert base_username("Aria K") == "aria.k"
    assert base_username("Chen") == "chen"
    assert base_username("Zoë  van der Berg") == "zoe.b"
    assert base_username("!!") == "student"


def test_a_taken_suggestion_gets_a_number() -> None:
    assert suggest_username("Aria K", {"aria.k"}) == "aria.k2"
    assert suggest_username("Aria K", {"aria.k", "aria.k2"}) == "aria.k3"


async def test_add_student_on_a_class_makes_the_account_and_returns_the_slip(
    client, signed_in
) -> None:
    headers = await signed_in()
    klass = (await client.post("/classes", json={"name": "Y4"}, headers=headers)).json()
    response = await client.post(
        f"/classes/{klass['id']}/students",
        json={"display_name": "Aria Kim", "pin": "4827"},
        headers=headers,
    )
    assert response.status_code == 201
    slip = response.json()
    assert (slip["username"], slip["pin"]) == ("aria.k", "4827")

    roster = (await client.get(f"/classes/{klass['id']}/roster", headers=headers)).json()
    assert [(r["username"], r["has_pin"]) for r in roster] == [("aria.k", True)]
    assert "pin" not in roster[0], "the roster never carries a PIN"

    # And the child can sign in with exactly that.
    signed = await client.post("/auth/student/session", json={"username": "aria.k", "pin": "4827"})
    assert signed.status_code == 200


async def test_a_chosen_username_that_is_taken_suggests_another(client, signed_in) -> None:
    headers = await signed_in()
    await client.post("/students", json={"display_name": "Aria K"}, headers=headers)
    clash = await client.post(
        "/students", json={"display_name": "Aria King", "username": "ARIA.K"}, headers=headers
    )
    assert clash.status_code == 409
    assert clash.json()["detail"]["suggestion"] == "aria.k2"


async def test_a_badly_formed_username_is_refused(client, signed_in) -> None:
    headers = await signed_in()
    for bad in ["a", "has space", "emoji😀", "UPPER_case", "x" * 31]:
        response = await client.post(
            "/students", json={"display_name": "Aria K", "username": bad}, headers=headers
        )
        assert response.status_code == 422, bad


async def test_the_teacher_can_change_a_username(client, signed_in) -> None:
    headers = await signed_in()
    aria = (await client.post("/students", json={"display_name": "Aria K"}, headers=headers)).json()
    bella = (
        await client.post("/students", json={"display_name": "Bella N"}, headers=headers)
    ).json()

    changed = await client.patch(
        f"/students/{aria['id']}", json={"username": "aria.kim"}, headers=headers
    )
    assert changed.json()["username"] == "aria.kim"
    # Keeping your own username is not a clash; taking someone else's is.
    same = await client.patch(
        f"/students/{aria['id']}", json={"username": "aria.kim"}, headers=headers
    )
    assert same.status_code == 200
    taken = await client.patch(
        f"/students/{aria['id']}", json={"username": bella["username"]}, headers=headers
    )
    assert taken.status_code == 409


async def test_the_suggestion_route_skips_taken_names(client, signed_in) -> None:
    headers = await signed_in()
    await client.post("/students", json={"display_name": "Aria K"}, headers=headers)
    response = await client.get(
        "/students/username-suggestion", params={"name": "Aria Kelly"}, headers=headers
    )
    assert response.json() == {"username": "aria.k2"}


async def test_pasted_children_get_usernames_too(client, signed_in) -> None:
    headers = await signed_in()
    klass = (await client.post("/classes", json={"name": "Y4"}, headers=headers)).json()
    added = await client.post(
        f"/classes/{klass['id']}/roster/bulk",
        json={"entries": [{"display_name": "Aria K"}, {"display_name": "Aria Kelly"}]},
        headers=headers,
    )
    assert sorted(e["username"] for e in added.json()) == ["aria.k", "aria.k2"]


async def test_a_student_cannot_see_usernames_or_make_accounts(client, signed_in_student) -> None:
    await signed_in_student()
    assert (
        await client.get("/students/username-suggestion", params={"name": "x"})
    ).status_code == 403
    assert (await client.post("/students", json={"display_name": "Eve"})).status_code == 403
