"""Centre-scoped lookups — the one place the tenancy filter lives.

**Routers must not build their own queries against a centre-owned table.** Every read of
`classes`, `students`, `enrolments`, `class_join_codes`, `student_documents` or the
curriculum tables goes through a helper here that takes a `Principal` and applies
`centre_id` itself.

Most helpers here scope by tenant alone, because the caller is a teacher and teachers at a
centre share everything. `student_documents` is the exception and the first of its kind:
a document belongs to **one child**, so its filter carries `student_id` as well. When a
student principal is the subject of its own query, the subject is part of the boundary.

The reason is the shape of the realistic failure. Nobody forgets the filter today, while
there are two routes and the boundary is the thing being built. The omission happens in
six months, on the seventh route, added quickly — and one missing
`.where(centre_id == ...)` is a cross-tenant read of children's records. Making the
filter something a route cannot express without is cheaper than remembering it.

The review rule that falls out: a bare `select(Class)` in a router is a bug.

**Not found and not yours return the same 404.** A 403 would confirm that an id exists,
which is information the caller has no legitimate way to hold.
"""

import uuid
from collections.abc import Sequence

from fastapi import HTTPException, status
from sqlmodel import func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import Principal
from app.models import (
    Assignment,
    AssignmentStatus,
    Attempt,
    Centre,
    Class,
    ClassJoinCode,
    ClassStatus,
    Concept,
    ConceptStatus,
    Course,
    CurriculumStatus,
    DocumentStatus,
    Enrolment,
    EnrolmentStatus,
    Item,
    ItemConcept,
    ItemStatus,
    Lesson,
    LessonConcept,
    Student,
    StudentDocument,
    StudentStatus,
    TeacherDocument,
    Unit,
)


def _not_found(what: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{what} not found")


async def get_centre(session: AsyncSession, principal: Principal) -> Centre:
    centre = await session.get(Centre, principal.centre_id)
    if centre is None:  # pragma: no cover — a principal cannot exist without its centre
        raise _not_found("centre")
    return centre


async def get_owned_class(
    session: AsyncSession, principal: Principal, class_id: uuid.UUID
) -> Class:
    """A class in the principal's centre, or 404.

    Both halves of the filter matter: `id` finds it, `centre_id` decides whether the
    caller is allowed to know it exists.
    """
    found = (
        await session.exec(
            select(Class).where(
                Class.id == class_id,
                Class.centre_id == principal.centre_id,
            )
        )
    ).one_or_none()
    if found is None:
        raise _not_found("class")
    return found


async def list_owned_classes(
    session: AsyncSession, principal: Principal, include_archived: bool = False
) -> Sequence[Class]:
    """Every class in the principal's centre, newest first.

    Teachers at a centre see each other's classes: they cover each other's lessons, and a
    per-teacher filter would lock a covering teacher out of the roster they are about to
    need. `class_teachers` records who leads what; it does not gate visibility.

    Ordering is by id, which is UUIDv7 and therefore already in creation order — no
    separate sort column, and no tie-break problem when two classes are created in the
    same transaction.
    """
    statement = select(Class).where(Class.centre_id == principal.centre_id)
    if not include_archived:
        statement = statement.where(Class.status == ClassStatus.ACTIVE)
    statement = statement.order_by(Class.id.desc())  # type: ignore[attr-defined]
    return (await session.exec(statement)).all()


async def get_owned_student(
    session: AsyncSession, principal: Principal, student_id: uuid.UUID
) -> Student:
    """A student in the principal's centre, or 404.

    The same two-part filter as `get_owned_class`, and the same reasoning — except the
    stakes are higher here, because the row is a child's record rather than a class name.
    """
    found = (
        await session.exec(
            select(Student).where(
                Student.id == student_id,
                Student.centre_id == principal.centre_id,
            )
        )
    ).one_or_none()
    if found is None:
        raise _not_found("student")
    return found


async def list_owned_students(
    session: AsyncSession, principal: Principal, include_archived: bool = False
) -> Sequence[Student]:
    """Every student at the principal's centre, alphabetically.

    Deliberately *not* `id.desc()` like the class list. A roster is read down the page
    during roll call, so alphabetical order is the useful one; `lower()` keeps a
    lowercase-typed name from sorting after every capitalised one.

    Students in no class at all are included — a child can exist at the centre between
    terms, and a list that hid them would make them unreachable to re-enrol.
    """
    statement = select(Student).where(Student.centre_id == principal.centre_id)
    if not include_archived:
        statement = statement.where(Student.status == StudentStatus.ACTIVE)
    statement = statement.order_by(func.lower(Student.display_name))
    return (await session.exec(statement)).all()


async def list_class_roster(
    session: AsyncSession,
    principal: Principal,
    class_id: uuid.UUID,
    include_withdrawn: bool = False,
) -> Sequence[tuple[Enrolment, Student]]:
    """The students enrolled in one of the principal's classes, alphabetically.

    Call `get_owned_class` first if the class itself needs to 404 — this returns an empty
    list for a class in another centre, which is right for a join but says nothing about
    whether the class exists.

    Both `Class.centre_id` and `Student.centre_id` are filtered. That is belt and braces:
    nothing should ever write an enrolment joining two centres, and if something did, this
    is the query that must not return it.
    """
    statement = (
        select(Enrolment, Student)
        .join(Student, Enrolment.student_id == Student.id)  # type: ignore[arg-type]
        .join(Class, Enrolment.class_id == Class.id)  # type: ignore[arg-type]
        .where(
            Enrolment.class_id == class_id,
            Class.centre_id == principal.centre_id,
            Student.centre_id == principal.centre_id,
        )
    )
    if not include_withdrawn:
        statement = statement.where(Enrolment.status == EnrolmentStatus.ACTIVE)
    statement = statement.order_by(func.lower(Student.display_name))
    return (await session.exec(statement)).all()


async def list_student_enrolments(
    session: AsyncSession, principal: Principal, student_id: uuid.UUID
) -> Sequence[tuple[Enrolment, Class]]:
    """Every class one student has been in, newest first, withdrawn ones included.

    Withdrawn enrolments are always returned: "which classes has this child been in" is a
    question about their history, and hiding the withdrawn ones would answer a different
    one. It is also what a teacher needs to see before archiving them.
    """
    statement = (
        select(Enrolment, Class)
        .join(Class, Enrolment.class_id == Class.id)  # type: ignore[arg-type]
        .where(
            Enrolment.student_id == student_id,
            Class.centre_id == principal.centre_id,
        )
        .order_by(Enrolment.id.desc())  # type: ignore[attr-defined]
    )
    return (await session.exec(statement)).all()


async def get_live_join_code(
    session: AsyncSession, principal: Principal, class_id: uuid.UUID
) -> ClassJoinCode | None:
    """The class's current join code, or None if it has never had one.

    A class minted after step 6 always has one; a class created before it does not, and a
    rotate mints the first. None is therefore a real state rather than an error.

    Tenancy is applied by joining to `classes` — `class_join_codes` carries no `centre_id`
    of its own, so the filter has to come from the class it belongs to.
    """
    return (
        await session.exec(
            select(ClassJoinCode)
            .join(Class, ClassJoinCode.class_id == Class.id)  # type: ignore[arg-type]
            .where(
                ClassJoinCode.class_id == class_id,
                ClassJoinCode.revoked_at.is_(None),  # type: ignore[union-attr]
                Class.centre_id == principal.centre_id,
            )
            .order_by(ClassJoinCode.id.desc())  # type: ignore[attr-defined]
        )
    ).first()


async def get_owned_document(
    session: AsyncSession, principal: Principal, document_id: uuid.UUID
) -> StudentDocument:
    """One of the calling student's own documents, or 404.

    Three-part filter, and all three matter. `id` finds the row; `centre_id` is the tenancy
    boundary as everywhere else; and **`student_id` is the subject boundary** — without it,
    any signed-in child could read any other child's work by guessing a uuid, which is a
    worse leak than the cross-centre one because it needs no second account.

    Archived documents are returned. A student reopening something they put away should get
    it, and the file list is what filters on status.
    """
    found = (
        await session.exec(
            select(StudentDocument).where(
                StudentDocument.id == document_id,
                StudentDocument.centre_id == principal.centre_id,
                StudentDocument.student_id == principal.subject_id,
            )
        )
    ).one_or_none()
    if found is None:
        raise _not_found("document")
    return found


async def get_own_teacher_document(
    session: AsyncSession, principal: Principal, document_id: uuid.UUID
) -> TeacherDocument:
    """One of the calling teacher's own files ("My code"), or 404.

    The same three-part filter as a child's files: `centre_id` is the tenancy boundary and
    **`user_id` is the "only me" boundary** — another teacher at the same centre gets a 404
    for this file, never a 403 that would confirm it exists.
    """
    found = (
        await session.exec(
            select(TeacherDocument).where(
                TeacherDocument.id == document_id,
                TeacherDocument.centre_id == principal.centre_id,
                TeacherDocument.user_id == principal.subject_id,
            )
        )
    ).one_or_none()
    if found is None:
        raise _not_found("document")
    return found


async def list_own_teacher_documents(
    session: AsyncSession, principal: Principal, include_archived: bool = False
) -> Sequence[TeacherDocument]:
    """The calling teacher's own files, most recently worked on first."""
    statement = select(TeacherDocument).where(
        TeacherDocument.centre_id == principal.centre_id,
        TeacherDocument.user_id == principal.subject_id,
    )
    if not include_archived:
        statement = statement.where(TeacherDocument.status == DocumentStatus.ACTIVE)
    statement = statement.order_by(TeacherDocument.updated_at.desc())  # type: ignore[attr-defined]
    return (await session.exec(statement)).all()


async def list_student_documents(
    session: AsyncSession, principal: Principal, include_archived: bool = False
) -> Sequence[StudentDocument]:
    """The calling student's own files, most recently worked on first.

    Ordered by `updated_at` rather than by id: a child returning to last week's work wants
    what they were last editing at the top, not what they happened to create last.
    """
    statement = select(StudentDocument).where(
        StudentDocument.centre_id == principal.centre_id,
        StudentDocument.student_id == principal.subject_id,
    )
    if not include_archived:
        statement = statement.where(StudentDocument.status == DocumentStatus.ACTIVE)
    statement = statement.order_by(StudentDocument.updated_at.desc())  # type: ignore[attr-defined]
    return (await session.exec(statement)).all()


async def get_enrolment(
    session: AsyncSession, principal: Principal, class_id: uuid.UUID, student_id: uuid.UUID
) -> Enrolment | None:
    """One student's enrolment in one class, or None.

    Returns None rather than raising, because callers need to tell "never enrolled"
    (insert) apart from "withdrawn" (reactivate) — `uq_enrolments_class_student` ignores
    status, so a withdrawn row cannot be replaced by a second insert.

    Tenancy is the caller's job here: both ids must already have come through
    `get_owned_class` and `get_owned_student`.
    """
    return (
        await session.exec(
            select(Enrolment).where(
                Enrolment.class_id == class_id,
                Enrolment.student_id == student_id,
            )
        )
    ).one_or_none()


# --- curriculum -----------------------------------------------------------------------
#
# Courses, units and lessons each carry their own `centre_id` (see `models/curriculum.py`),
# so each lookup is the same two-part filter as `get_owned_class` — one helper per table
# rather than one generic one, so a reviewer grepping for `Lesson.centre_id` finds it.


async def get_owned_course(
    session: AsyncSession, principal: Principal, course_id: uuid.UUID
) -> Course:
    found = (
        await session.exec(
            select(Course).where(Course.id == course_id, Course.centre_id == principal.centre_id)
        )
    ).one_or_none()
    if found is None:
        raise _not_found("course")
    return found


async def list_owned_courses(
    session: AsyncSession, principal: Principal, include_archived: bool = False
) -> Sequence[Course]:
    """Every course at the principal's centre, newest first — by id, as classes are."""
    statement = select(Course).where(Course.centre_id == principal.centre_id)
    if not include_archived:
        statement = statement.where(Course.status == CurriculumStatus.ACTIVE)
    statement = statement.order_by(Course.id.desc())  # type: ignore[attr-defined]
    return (await session.exec(statement)).all()


async def get_owned_unit(session: AsyncSession, principal: Principal, unit_id: uuid.UUID) -> Unit:
    found = (
        await session.exec(
            select(Unit).where(Unit.id == unit_id, Unit.centre_id == principal.centre_id)
        )
    ).one_or_none()
    if found is None:
        raise _not_found("unit")
    return found


async def get_owned_lesson(
    session: AsyncSession, principal: Principal, lesson_id: uuid.UUID
) -> Lesson:
    found = (
        await session.exec(
            select(Lesson).where(Lesson.id == lesson_id, Lesson.centre_id == principal.centre_id)
        )
    ).one_or_none()
    if found is None:
        raise _not_found("lesson")
    return found


async def list_course_outline(
    session: AsyncSession, principal: Principal, course_id: uuid.UUID, include_archived: bool
) -> tuple[Sequence[Unit], Sequence[Lesson], Sequence[LessonConcept]]:
    """A course's units, their lessons, and those lessons' concept links, in sort order.

    Three flat queries rather than one join, because the router assembles a tree and a
    join would repeat every unit once per lesson. Each is filtered by centre on its own
    table — call `get_owned_course` first if the course itself needs to 404.

    `include_archived` applies to units and lessons alike; an archived unit's lessons are
    left out with it, since a lesson in a unit nobody can see is not reachable to edit.
    """
    unit_statement = select(Unit).where(
        Unit.course_id == course_id, Unit.centre_id == principal.centre_id
    )
    if not include_archived:
        unit_statement = unit_statement.where(Unit.status == CurriculumStatus.ACTIVE)
    units = (
        await session.exec(unit_statement.order_by(Unit.sort_order, Unit.id))  # type: ignore[arg-type]
    ).all()

    unit_ids = [unit.id for unit in units]
    if not unit_ids:
        return units, [], []
    lesson_statement = select(Lesson).where(
        Lesson.unit_id.in_(unit_ids),  # type: ignore[attr-defined]
        Lesson.centre_id == principal.centre_id,
    )
    if not include_archived:
        lesson_statement = lesson_statement.where(Lesson.status == CurriculumStatus.ACTIVE)
    lessons = (
        await session.exec(lesson_statement.order_by(Lesson.sort_order, Lesson.id))  # type: ignore[arg-type]
    ).all()

    lesson_ids = [lesson.id for lesson in lessons]
    if not lesson_ids:
        return units, lessons, []
    links = (
        await session.exec(
            select(LessonConcept).where(LessonConcept.lesson_id.in_(lesson_ids))  # type: ignore[attr-defined]
        )
    ).all()
    return units, lessons, links


async def list_visible_concepts(session: AsyncSession, principal: Principal) -> list[Concept]:
    """The taxonomy as this centre sees it: global concepts, with the centre's own on top.

    A centre concept whose key matches a global one *replaces* it — that is what "override"
    in `models/concepts.py` means — so the result has one row per key. Archived concepts
    are left out; provisional ones are not, because the whole taxonomy is provisional
    until next term's scope and sequence is confirmed.
    """
    rows = (
        await session.exec(
            select(Concept).where(
                (Concept.centre_id == principal.centre_id) | (Concept.centre_id.is_(None)),  # type: ignore[union-attr]
                Concept.status != ConceptStatus.ARCHIVED,
            )
        )
    ).all()
    by_key: dict[str, Concept] = {}
    for concept in rows:
        if concept.key not in by_key or concept.centre_id is not None:
            by_key[concept.key] = concept
    return sorted(by_key.values(), key=lambda c: (c.sort_order, c.key))


# --- problem bank -----------------------------------------------------------------------


async def get_owned_item(session: AsyncSession, principal: Principal, item_id: uuid.UUID) -> Item:
    """A top-level item in the principal's centre, or 404.

    Parts are not addressable on their own here: a part is edited, versioned and published
    as part of its parent, so a route that took a part's id would be a second way to change
    one half of a problem.
    """
    found = (
        await session.exec(
            select(Item).where(
                Item.id == item_id,
                Item.centre_id == principal.centre_id,
                Item.parent_id.is_(None),  # type: ignore[union-attr]
            )
        )
    ).one_or_none()
    if found is None:
        raise _not_found("problem")
    return found


async def list_owned_items(
    session: AsyncSession,
    principal: Principal,
    *,
    statuses: Sequence[ItemStatus],
    concept_id: uuid.UUID | None = None,
    difficulty: int | None = None,
    search: str | None = None,
) -> Sequence[Item]:
    """Top-level items at the principal's centre, most recently edited first.

    The concept filter matches a tag on the item *or on any of its parts* — a teacher
    looking for list problems wants the three-part problem whose part (b) drills lists.
    """
    statement = select(Item).where(
        Item.centre_id == principal.centre_id,
        Item.parent_id.is_(None),  # type: ignore[union-attr]
        Item.status.in_(list(statuses)),  # type: ignore[attr-defined]
    )
    if difficulty is not None:
        statement = statement.where(Item.difficulty == difficulty)
    if search:
        statement = statement.where(Item.title.ilike(f"%{search}%"))  # type: ignore[attr-defined]
    if concept_id is not None:
        tagged = (
            select(Item.id)
            .join(ItemConcept, ItemConcept.item_id == Item.id)
            .where(  # type: ignore[arg-type]
                ItemConcept.concept_id == concept_id,
                Item.centre_id == principal.centre_id,
            )
        )
        parents_of_tagged = select(Item.parent_id).where(
            Item.id.in_(tagged),  # type: ignore[attr-defined]
            Item.parent_id.is_not(None),  # type: ignore[union-attr]
        )
        statement = statement.where(
            Item.id.in_(tagged) | Item.id.in_(parents_of_tagged)  # type: ignore[attr-defined]
        )
    statement = statement.order_by(Item.updated_at.desc())  # type: ignore[attr-defined]
    return (await session.exec(statement)).all()


async def list_item_parts(
    session: AsyncSession, principal: Principal, item_id: uuid.UUID
) -> Sequence[Item]:
    """An item's parts, a → c. The parent must already have come through scoping."""
    return (
        await session.exec(
            select(Item)
            .where(Item.parent_id == item_id, Item.centre_id == principal.centre_id)
            .order_by(Item.sort_order, Item.part_label)  # type: ignore[arg-type]
        )
    ).all()


# --- a student's own work -----------------------------------------------------------------
#
# The subject boundary again, as for `student_documents`: a child reaches an assignment only
# through a class they are *actively* enrolled in, and an attempt only if it is their own.
# A withdrawn child loses access to the class's work at once, which is what withdrawal
# means; their attempts stay in the database for the teacher.


async def get_student_assignment(
    session: AsyncSession,
    principal: Principal,
    assignment_id: uuid.UUID,
    *,
    include_closed: bool = False,
) -> Assignment:
    """An open assignment in one of the calling student's active classes, or 404.

    `include_closed` is for *reading*: a closed homework with feedback on it is still the
    child's to look at. Drafts and archived assignments are never visible to a child.
    """
    statuses = [AssignmentStatus.OPEN] + ([AssignmentStatus.CLOSED] if include_closed else [])
    found = (
        await session.exec(
            select(Assignment)
            .join(Enrolment, Enrolment.class_id == Assignment.class_id)  # type: ignore[arg-type]
            .where(
                Assignment.id == assignment_id,
                Assignment.centre_id == principal.centre_id,
                Assignment.status.in_(statuses),  # type: ignore[attr-defined]
                Enrolment.student_id == principal.subject_id,
                Enrolment.status == EnrolmentStatus.ACTIVE,
            )
        )
    ).one_or_none()
    if found is None:
        raise _not_found("assignment")
    return found


async def get_own_attempt(
    session: AsyncSession, principal: Principal, attempt_id: uuid.UUID
) -> Attempt:
    """One of the calling student's own attempts, or 404 — the three-part filter."""
    found = (
        await session.exec(
            select(Attempt).where(
                Attempt.id == attempt_id,
                Attempt.centre_id == principal.centre_id,
                Attempt.student_id == principal.subject_id,
            )
        )
    ).one_or_none()
    if found is None:
        raise _not_found("attempt")
    return found


async def get_student_class(session: AsyncSession, principal: Principal) -> Class | None:
    """The class a signed-in student is in: their newest active enrolment.

    The same rule `/auth/student/me` uses, so the class a child is told they are in and the
    class whose lesson they are shown cannot disagree.
    """
    return (
        await session.exec(
            select(Class)
            .join(Enrolment, Enrolment.class_id == Class.id)  # type: ignore[arg-type]
            .where(
                Enrolment.student_id == principal.subject_id,
                Enrolment.status == EnrolmentStatus.ACTIVE,
                Class.centre_id == principal.centre_id,
            )
            .order_by(Enrolment.id.desc())  # type: ignore[attr-defined]
        )
    ).first()


async def get_owned_assignment(
    session: AsyncSession, principal: Principal, assignment_id: uuid.UUID
) -> Assignment:
    """An assignment at the principal's centre, or 404 — the teacher's view of one."""
    found = (
        await session.exec(
            select(Assignment).where(
                Assignment.id == assignment_id,
                Assignment.centre_id == principal.centre_id,
            )
        )
    ).one_or_none()
    if found is None:
        raise _not_found("assignment")
    return found


async def get_centre_attempt(
    session: AsyncSession, principal: Principal, attempt_id: uuid.UUID
) -> Attempt:
    """Any attempt at the principal's centre, or 404 — for a teacher marking it.

    Teachers at a centre share classes, so they share the marking of them. The subject
    boundary that `get_own_attempt` enforces is a *student's*; a teacher reaching a child's
    work is what marking is.
    """
    found = (
        await session.exec(
            select(Attempt).where(
                Attempt.id == attempt_id,
                Attempt.centre_id == principal.centre_id,
            )
        )
    ).one_or_none()
    if found is None:
        raise _not_found("attempt")
    return found
