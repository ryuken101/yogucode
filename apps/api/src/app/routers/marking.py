"""Marking homework — question by question across the class (spec §3.5).

The screen this serves shows one question, one child at a time, and moves along the class
with the arrow keys: faster and more consistent than marking child by child, and it makes
reusing a comment natural. So the main read is **one question, every child's answer**.

What the teacher is given for each child: their latest hand-in (or, if they never pressed
Hand in, their saved work — Ken's decision that forgetting the button should not cost a
child their feedback), whether it was late, how many hints they used, and any mark so far.
The problem's tests come with it, hidden ones included, so the teacher's browser can re-run
them: that re-run, not the child's own report, is what fills in Runs and Correct.

**Marks are invisible to children until Release**, which stamps every unreleased mark and
note at once and can be pressed again after marking more. Every mark saved is audited:
it is a teacher's judgement entered against a child's record.
"""

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlmodel import col, select, update
from sqlmodel.ext.asyncio.session import AsyncSession

from app.audit import audit_entry
from app.auth.principal import CurrentTeacher, Principal
from app.db import get_session
from app.homework import Leaf, latest_submissions, set_leaves
from app.models import (
    Assignment,
    AssignmentMode,
    AssignmentNote,
    Attempt,
    EnrolmentStatus,
    FeedbackSnippet,
    ItemKind,
    Mark,
    SnippetStatus,
    Student,
    Submission,
    SubmissionSource,
)
from app.models.base import utcnow
from app.problem_bank import (
    CompareTest,
    FunctionTest,
    IoTest,
    ScriptTest,
    read_document,
    with_reference,
)
from app.scoping import (
    get_centre_attempt,
    get_owned_assignment,
    get_owned_student,
    list_class_roster,
    list_visible_concepts,
)

router = APIRouter(tags=["marking"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]


# --- shapes -------------------------------------------------------------------------


class QuestionOut(BaseModel):
    leaf_item_id: uuid.UUID
    title: str
    difficulty: int
    handed_in: int
    marked: int


class MarkingStudentOut(BaseModel):
    student_id: uuid.UUID
    display_name: str


class MarkingOverviewOut(BaseModel):
    assignment_id: uuid.UUID
    title: str
    due_at: datetime | None
    released_at: datetime | None
    questions: list[QuestionOut]
    students: list[MarkingStudentOut]


class MarkOut(BaseModel):
    runs: bool
    correct: int
    approach: int | None
    comment_md: str
    verified_passed: int | None
    verified_total: int | None
    released: bool
    # The child handed in again after this mark was written; the mark is on an older copy.
    stale: bool


class MarkingEntryOut(BaseModel):
    student_id: uuid.UUID
    display_name: str
    attempt_id: uuid.UUID | None
    code: str | None
    source: Literal["hand_in", "saved_work", "not_handed_in", "not_started"]
    submitted_at: datetime | None
    late: bool
    # The child's own browser's last check, for comparison with the teacher's re-run.
    child_passed: int | None
    child_total: int | None
    hints_used: int
    mark: MarkOut | None
    note: str
    # Multiple choice: the option picked (latest hand-in, else as it stands).
    choice: int | None = None


class OptionCountOut(BaseModel):
    """One answer to a multiple-choice question, and how many children chose it."""

    text: str
    correct: bool
    misconception: str | None
    chosen_by: int


class QuestionMarkingOut(BaseModel):
    assignment_id: uuid.UUID
    leaf_item_id: uuid.UUID
    kind: ItemKind
    title: str
    prompt_md: str
    solution_code: str
    concept_ids: list[uuid.UUID]
    tests: list[IoTest | FunctionTest | ScriptTest | CompareTest]
    # Multiple choice: every option with its count — spec §3.6's "six chose 'range is
    # inclusive'", which is a reteaching plan rather than a score.
    options: list[OptionCountOut]
    entries: list[MarkingEntryOut]


class MarkIn(BaseModel):
    runs: bool
    correct: int = Field(ge=0, le=2)
    approach: int | None = Field(default=None, ge=0, le=2)
    comment_md: str = Field(default="", max_length=4000)
    verified_passed: int | None = Field(default=None, ge=0, le=100)
    verified_total: int | None = Field(default=None, ge=0, le=100)
    # Snippets used in this comment, so the bank learns which ones earn their place.
    snippet_ids: list[uuid.UUID] = Field(default_factory=list, max_length=20)


class NoteIn(BaseModel):
    note: str = Field(max_length=2000)


class ReleaseOut(BaseModel):
    marks_released: int
    notes_released: int


class SnippetIn(BaseModel):
    body: str = Field(min_length=1, max_length=2000)
    concept_id: uuid.UUID | None = None


class SnippetPatch(BaseModel):
    body: str | None = Field(default=None, min_length=1, max_length=2000)
    concept_id: uuid.UUID | None = None


class SnippetOut(BaseModel):
    id: uuid.UUID
    body: str
    concept_id: uuid.UUID | None
    use_count: int
    status: SnippetStatus

    @classmethod
    def build(cls, row: FeedbackSnippet) -> "SnippetOut":
        return cls(
            id=row.id,
            body=row.body,
            concept_id=row.concept_id,
            use_count=row.use_count,
            status=row.status,
        )


# --- helpers ------------------------------------------------------------------------


def _not_found(what: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{what} not found")


async def _homework(
    session: AsyncSession, principal: Principal, assignment_id: uuid.UUID
) -> Assignment:
    """Homework or a quiz — both are marked, and given back, the same way."""
    assignment = await get_owned_assignment(session, principal, assignment_id)
    if assignment.mode not in (AssignmentMode.HOMEWORK, AssignmentMode.QUIZ):
        raise _not_found("homework")
    return assignment


async def _students(
    session: AsyncSession, principal: Principal, assignment: Assignment
) -> list[Student]:
    """The class, plus anyone since withdrawn who did work on this sheet."""
    with_work = set(
        (
            await session.exec(
                select(Attempt.student_id).where(Attempt.assignment_id == assignment.id)
            )
        ).all()
    )
    roster = await list_class_roster(
        session, principal, assignment.class_id, include_withdrawn=True
    )
    return [
        student
        for enrolment, student in roster
        if enrolment.status == EnrolmentStatus.ACTIVE or student.id in with_work
    ]


async def _attempts(
    session: AsyncSession, principal: Principal, assignment: Assignment
) -> list[Attempt]:
    return list(
        (
            await session.exec(
                select(Attempt).where(
                    Attempt.assignment_id == assignment.id,
                    Attempt.centre_id == principal.centre_id,
                )
            )
        ).all()
    )


async def _leaf(
    session: AsyncSession, principal: Principal, assignment: Assignment, leaf_item_id: uuid.UUID
) -> Leaf:
    for leaf in await set_leaves(session, principal, assignment.set_id):
        if leaf.leaf.id == leaf_item_id:
            return leaf
    raise _not_found("question")


async def _marks(session: AsyncSession, attempt_ids: list[uuid.UUID]) -> dict[uuid.UUID, Mark]:
    if not attempt_ids:
        return {}
    rows = (await session.exec(select(Mark).where(col(Mark.attempt_id).in_(attempt_ids)))).all()
    return {row.attempt_id: row for row in rows}


# --- reading ------------------------------------------------------------------------


@router.get("/assignments/{assignment_id}/marking", response_model=MarkingOverviewOut)
async def marking_overview(
    assignment_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> MarkingOverviewOut:
    """The sheet's questions with how many are handed in and marked, and the class."""
    assignment = await _homework(session, principal, assignment_id)
    leaves = await set_leaves(session, principal, assignment.set_id)
    attempts = await _attempts(session, principal, assignment)
    submissions = await latest_submissions(session, principal, [a.id for a in attempts])
    marks = await _marks(session, [a.id for a in attempts])
    by_leaf: dict[uuid.UUID, list[Attempt]] = {}
    for attempt in attempts:
        by_leaf.setdefault(attempt.item_id, []).append(attempt)
    return MarkingOverviewOut(
        assignment_id=assignment.id,
        title=assignment.title,
        due_at=assignment.due_at,
        released_at=assignment.released_at,
        questions=[
            QuestionOut(
                leaf_item_id=leaf.leaf.id,
                title=leaf.label,
                difficulty=leaf.leaf.difficulty,
                handed_in=sum(
                    1
                    for a in by_leaf.get(leaf.leaf.id, [])
                    if a.id in submissions and submissions[a.id].source == SubmissionSource.HAND_IN
                ),
                marked=sum(1 for a in by_leaf.get(leaf.leaf.id, []) if a.id in marks),
            )
            for leaf in leaves
        ],
        students=[
            MarkingStudentOut(student_id=s.id, display_name=s.display_name)
            for s in await _students(session, principal, assignment)
        ],
    )


@router.get(
    "/assignments/{assignment_id}/marking/{leaf_item_id}", response_model=QuestionMarkingOut
)
async def mark_question(
    assignment_id: uuid.UUID,
    leaf_item_id: uuid.UUID,
    principal: CurrentTeacher,
    session: SessionDep,
) -> QuestionMarkingOut:
    """One question, every child's answer to it, in roster order."""
    assignment = await _homework(session, principal, assignment_id)
    leaf = await _leaf(session, principal, assignment, leaf_item_id)
    doc, part_rows = await read_document(session, principal, leaf.problem)
    leaf_doc = (
        next(p for p, row in zip(doc.parts, part_rows, strict=True) if row.id == leaf.leaf.id)
        if leaf.leaf.parent_id
        else doc
    )
    prompt = doc.prompt_md + (f"\n\n{leaf_doc.prompt_md}" if leaf.leaf.parent_id else "")

    attempts = {
        a.student_id: a
        for a in await _attempts(session, principal, assignment)
        if a.item_id == leaf.leaf.id
    }
    submissions = await latest_submissions(session, principal, [a.id for a in attempts.values()])
    marks = await _marks(session, [a.id for a in attempts.values()])
    notes = {
        n.student_id: n.note
        for n in (
            await session.exec(
                select(AssignmentNote).where(AssignmentNote.assignment_id == assignment.id)
            )
        ).all()
    }

    entries = []
    for student in await _students(session, principal, assignment):
        attempt = attempts.get(student.id)
        submission = submissions.get(attempt.id) if attempt else None
        mark = marks.get(attempt.id) if attempt else None
        if attempt is None:
            source, code, choice = "not_started", None, None
        elif submission is None:
            source, code, choice = "not_handed_in", attempt.code, attempt.choice
        else:
            # Read back from the database as a plain string, not the enum.
            source = SubmissionSource(submission.source).value
            code, choice = submission.code, submission.choice
        entries.append(
            MarkingEntryOut(
                student_id=student.id,
                display_name=student.display_name,
                attempt_id=attempt.id if attempt else None,
                code=code,
                source=source,
                submitted_at=submission.submitted_at if submission else None,
                late=bool(submission and submission.late),
                child_passed=submission.passed if submission else None,
                child_total=submission.total if submission else None,
                hints_used=attempt.hints_unlocked if attempt else 0,
                mark=MarkOut(
                    runs=mark.runs,
                    correct=mark.correct,
                    approach=mark.approach,
                    comment_md=mark.comment_md,
                    verified_passed=mark.verified_passed,
                    verified_total=mark.verified_total,
                    released=mark.released_at is not None,
                    stale=bool(submission and mark.submission_id != submission.id),
                )
                if mark
                else None,
                note=notes.get(student.id, ""),
                choice=choice,
            )
        )
    solution = doc.solution_code if doc.shared_file else leaf_doc.solution_code
    counts = [0] * len(leaf_doc.options) if leaf.leaf.kind == ItemKind.MCQ else []
    for entry in entries:
        if entry.choice is not None and 0 <= entry.choice < len(counts):
            counts[entry.choice] += 1
    return QuestionMarkingOut(
        assignment_id=assignment.id,
        leaf_item_id=leaf.leaf.id,
        kind=leaf.leaf.kind,
        options=[
            OptionCountOut(
                text=option.text,
                correct=option.correct,
                misconception=option.misconception,
                chosen_by=counts[i],
            )
            for i, option in enumerate(leaf_doc.options)
        ]
        if counts
        else [],
        title=leaf.label,
        prompt_md=prompt,
        # A part of a shared file has no solution of its own: the file's is the one.
        solution_code=solution,
        concept_ids=leaf_doc.concept_ids,
        tests=with_reference(leaf_doc.tests, solution),
        entries=entries,
    )


# --- writing ------------------------------------------------------------------------


@router.put("/attempts/{attempt_id}/mark", response_model=MarkOut)
async def save_mark(
    attempt_id: uuid.UUID, body: MarkIn, principal: CurrentTeacher, session: SessionDep
) -> MarkOut:
    """Mark one child's answer to one question. Marks the latest hand-in; marking a child
    who never handed in takes a copy of their saved work first, so the mark always points
    at the exact code it judged."""
    attempt = await get_centre_attempt(session, principal, attempt_id)
    assignment = await _homework(session, principal, attempt.assignment_id)
    submission = (await latest_submissions(session, principal, [attempt.id])).get(attempt.id)
    if submission is None:
        submission = Submission(
            centre_id=principal.centre_id,
            attempt_id=attempt.id,
            code=attempt.code,
            choice=attempt.choice,
            source=SubmissionSource.SAVED_WORK,
        )
        session.add(submission)
        await session.flush()

    mark = (await _marks(session, [attempt.id])).get(attempt.id)
    if mark is None:
        mark = Mark(
            centre_id=principal.centre_id,
            attempt_id=attempt.id,
            submission_id=submission.id,
            marker_id=principal.subject_id,
            runs=body.runs,
            correct=body.correct,
        )
    mark.submission_id = submission.id
    mark.marker_id = principal.subject_id
    mark.runs = body.runs
    mark.correct = body.correct
    mark.approach = body.approach
    mark.comment_md = body.comment_md
    mark.verified_passed = body.verified_passed
    mark.verified_total = body.verified_total
    mark.updated_at = utcnow()
    session.add(mark)

    if body.snippet_ids:
        await session.exec(
            update(FeedbackSnippet)  # type: ignore[call-overload]
            .where(
                col(FeedbackSnippet.id).in_(body.snippet_ids),
                FeedbackSnippet.centre_id == principal.centre_id,
            )
            .values(use_count=FeedbackSnippet.use_count + 1)
        )
    session.add(
        audit_entry(
            principal,
            "mark.saved",
            "student",
            attempt.student_id,
            assignment_id=str(assignment.id),
            attempt_id=str(attempt.id),
            runs=body.runs,
            correct=body.correct,
            approach=body.approach,
        )
    )
    await session.commit()
    await session.refresh(mark)
    return MarkOut(
        runs=mark.runs,
        correct=mark.correct,
        approach=mark.approach,
        comment_md=mark.comment_md,
        verified_passed=mark.verified_passed,
        verified_total=mark.verified_total,
        released=mark.released_at is not None,
        stale=False,
    )


class AutoMarkOut(BaseModel):
    marked: int


@router.post("/assignments/{assignment_id}/marking/{leaf_item_id}/auto", response_model=AutoMarkOut)
async def auto_mark(
    assignment_id: uuid.UUID,
    leaf_item_id: uuid.UUID,
    principal: CurrentTeacher,
    session: SessionDep,
) -> AutoMarkOut:
    """Mark every answered, unmarked multiple-choice answer to one question: Correct 2 for
    the right option, 0 for any other. A teacher can still change any of them, or add a
    comment, afterwards. Code questions are never marked automatically — approach is a
    human call."""
    assignment = await _homework(session, principal, assignment_id)
    leaf = await _leaf(session, principal, assignment, leaf_item_id)
    if leaf.leaf.kind != ItemKind.MCQ:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Only multiple choice marks itself"
        )
    right = next((i for i, o in enumerate(leaf.leaf.options) if o.get("correct")), None)
    attempts = [
        a for a in await _attempts(session, principal, assignment) if a.item_id == leaf.leaf.id
    ]
    submissions = await latest_submissions(session, principal, [a.id for a in attempts])
    existing = await _marks(session, [a.id for a in attempts])
    marked = 0
    for attempt in attempts:
        if attempt.id in existing:
            continue
        submission = submissions.get(attempt.id)
        choice = submission.choice if submission else attempt.choice
        if choice is None:
            continue
        if submission is None:
            submission = Submission(
                centre_id=principal.centre_id,
                attempt_id=attempt.id,
                code=attempt.code,
                choice=attempt.choice,
                source=SubmissionSource.SAVED_WORK,
            )
            session.add(submission)
            await session.flush()
        session.add(
            Mark(
                centre_id=principal.centre_id,
                attempt_id=attempt.id,
                submission_id=submission.id,
                marker_id=principal.subject_id,
                runs=True,
                correct=2 if choice == right else 0,
            )
        )
        marked += 1
    session.add(
        audit_entry(
            principal,
            "mark.auto",
            "assignment",
            assignment.id,
            leaf_item_id=str(leaf.leaf.id),
            marked=marked,
        )
    )
    await session.commit()
    return AutoMarkOut(marked=marked)


@router.put("/assignments/{assignment_id}/notes/{student_id}", response_model=NoteIn)
async def save_note(
    assignment_id: uuid.UUID,
    student_id: uuid.UUID,
    body: NoteIn,
    principal: CurrentTeacher,
    session: SessionDep,
) -> NoteIn:
    """The optional overall note to one child on this homework."""
    assignment = await _homework(session, principal, assignment_id)
    student = await get_owned_student(session, principal, student_id)
    if student.id not in {s.id for s in await _students(session, principal, assignment)}:
        raise _not_found("student")
    note = await session.get(AssignmentNote, (assignment.id, student.id))
    if note is None:
        note = AssignmentNote(
            assignment_id=assignment.id,
            student_id=student.id,
            centre_id=principal.centre_id,
            marker_id=principal.subject_id,
        )
    note.note = body.note.strip()
    note.marker_id = principal.subject_id
    note.updated_at = utcnow()
    session.add(note)
    session.add(
        audit_entry(
            principal, "note.saved", "student", student.id, assignment_id=str(assignment.id)
        )
    )
    await session.commit()
    return NoteIn(note=note.note)


@router.post("/assignments/{assignment_id}/release", response_model=ReleaseOut)
async def release(
    assignment_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> ReleaseOut:
    """Give marked work back. Every mark and note not yet released goes out together.

    Children with no mark are untouched — they can still hand in, and are released next
    time. A child who has something back finds their sheet read-only.
    """
    assignment = await _homework(session, principal, assignment_id)
    now = utcnow()
    attempt_ids = [a.id for a in await _attempts(session, principal, assignment)]
    marks = [m for m in (await _marks(session, attempt_ids)).values() if m.released_at is None]
    notes = (
        await session.exec(
            select(AssignmentNote).where(
                AssignmentNote.assignment_id == assignment.id,
                col(AssignmentNote.released_at).is_(None),
                AssignmentNote.note != "",
            )
        )
    ).all()
    for row in [*marks, *notes]:
        row.released_at = now
        session.add(row)
    assignment.released_at = now
    session.add(assignment)
    session.add(
        audit_entry(
            principal,
            "homework.released",
            "assignment",
            assignment.id,
            marks=len(marks),
            notes=len(notes),
        )
    )
    await session.commit()
    return ReleaseOut(marks_released=len(marks), notes_released=len(notes))


# --- the snippet bank ---------------------------------------------------------------


async def _check_concept(
    session: AsyncSession, principal: Principal, concept_id: uuid.UUID | None
) -> None:
    if concept_id is not None and concept_id not in {
        c.id for c in await list_visible_concepts(session, principal)
    }:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="That concept is not available",
        )


async def _owned_snippet(
    session: AsyncSession, principal: Principal, snippet_id: uuid.UUID
) -> FeedbackSnippet:
    row = (
        await session.exec(
            select(FeedbackSnippet).where(
                FeedbackSnippet.id == snippet_id,
                FeedbackSnippet.centre_id == principal.centre_id,
            )
        )
    ).one_or_none()
    if row is None:
        raise _not_found("snippet")
    return row


@router.get("/snippets", response_model=list[SnippetOut])
async def list_snippets(
    principal: CurrentTeacher,
    session: SessionDep,
    q: Annotated[str | None, Query(max_length=120)] = None,
) -> list[SnippetOut]:
    """The centre's live snippets, most used first."""
    statement = select(FeedbackSnippet).where(
        FeedbackSnippet.centre_id == principal.centre_id,
        FeedbackSnippet.status == SnippetStatus.ACTIVE,
    )
    if q and q.strip():
        statement = statement.where(col(FeedbackSnippet.body).ilike(f"%{q.strip()}%"))
    rows = (
        await session.exec(
            statement.order_by(col(FeedbackSnippet.use_count).desc(), col(FeedbackSnippet.id))
        )
    ).all()
    return [SnippetOut.build(row) for row in rows]


@router.post("/snippets", response_model=SnippetOut, status_code=status.HTTP_201_CREATED)
async def create_snippet(
    body: SnippetIn, principal: CurrentTeacher, session: SessionDep
) -> SnippetOut:
    await _check_concept(session, principal, body.concept_id)
    row = FeedbackSnippet(
        centre_id=principal.centre_id,
        body=body.body.strip(),
        concept_id=body.concept_id,
        created_by=principal.subject_id,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return SnippetOut.build(row)


@router.patch("/snippets/{snippet_id}", response_model=SnippetOut)
async def update_snippet(
    snippet_id: uuid.UUID, body: SnippetPatch, principal: CurrentTeacher, session: SessionDep
) -> SnippetOut:
    row = await _owned_snippet(session, principal, snippet_id)
    fields = body.model_dump(exclude_unset=True)
    if body.body is not None:
        row.body = body.body.strip()
    if "concept_id" in fields:
        await _check_concept(session, principal, body.concept_id)
        row.concept_id = body.concept_id
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return SnippetOut.build(row)


@router.post("/snippets/{snippet_id}/archive", response_model=SnippetOut)
async def archive_snippet(
    snippet_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> SnippetOut:
    row = await _owned_snippet(session, principal, snippet_id)
    row.status = SnippetStatus.ARCHIVED
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return SnippetOut.build(row)
