"""Merging a duplicate teacher into the original (`app/merge_teachers.py`).

Duplicates were made before 23 Oct 2026 when a Supabase account was recreated: a second,
ordinary teacher with the same email, while the owner sat unused.
"""

import uuid

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.merge_teachers import merge_teachers
from app.models import ClassTeacher, TeacherDocument, User, UserRole, UserStatus


async def _duplicate_of(session: AsyncSession, owner: User) -> User:
    dup = User(
        supabase_user_id=uuid.uuid4(),
        centre_id=owner.centre_id,
        email=owner.email,
        display_name="Ken again",
        role=UserRole.TEACHER,
    )
    session.add(dup)
    await session.flush()
    return dup


async def test_the_duplicate_folds_into_the_owner(client, signed_in, session: AsyncSession) -> None:
    headers = await signed_in()
    owner = (await session.exec(select(User))).one()
    dup = await _duplicate_of(session, owner)

    # The duplicate made a class (as Lead), and both have a file with the same name.
    created = (await client.post("/classes", json={"name": "TEST class"}, headers=headers)).json()
    link = (await session.exec(select(ClassTeacher))).one()
    link.user_id = dup.id
    session.add(link)
    for who in (owner, dup):
        session.add(
            TeacherDocument(centre_id=owner.centre_id, user_id=who.id, title="demo.py", content="")
        )
    await session.flush()
    login = dup.supabase_user_id

    counts = await merge_teachers(session, owner.id, dup.id)

    await session.refresh(owner)
    await session.refresh(dup)
    assert owner.supabase_user_id == login, "the owner takes over the login in use"
    assert owner.role == UserRole.OWNER
    assert dup.status == UserStatus.DISABLED
    teachers = (
        await session.exec(
            select(ClassTeacher).where(ClassTeacher.class_id == uuid.UUID(created["id"]))
        )
    ).all()
    assert [(t.user_id, t.role) for t in teachers] == [(owner.id, "lead")]
    titles = sorted(
        d.title
        for d in (
            await session.exec(select(TeacherDocument).where(TeacherDocument.user_id == owner.id))
        ).all()
    )
    assert titles == ["demo (merged).py", "demo.py"]
    assert counts["teacher_documents.user_id"] == 1


async def test_both_on_one_class_keeps_one_row_and_the_lead(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    owner = (await session.exec(select(User))).one()
    dup = await _duplicate_of(session, owner)
    created = (await client.post("/classes", json={"name": "TEST class"}, headers=headers)).json()
    mine = (await session.exec(select(ClassTeacher))).one()
    mine.role = "assistant"
    session.add(mine)
    session.add(ClassTeacher(class_id=uuid.UUID(created["id"]), user_id=dup.id, role="lead"))
    await session.flush()

    await merge_teachers(session, owner.id, dup.id)

    rows = (await session.exec(select(ClassTeacher))).all()
    assert [(r.user_id, r.role) for r in rows] == [(owner.id, "lead")]
