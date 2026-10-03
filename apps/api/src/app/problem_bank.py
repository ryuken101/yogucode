"""A problem as one document — the shape the editor saves and the YAML import reads.

A problem is spread over five tables (`items` for the problem and its parts, plus
`item_concepts`, `test_cases`, `hints`), but nobody authors it that way. The editor shows
one page and saves one page, and a YAML file describes one problem per entry. So the
document here is the unit of reading and writing, and the tables are storage.

**Saving a draft replaces its child rows.** Tests, hints, tags and parts that are no longer
in the document are deleted, not archived. That is a deliberate exception to "archive,
never delete": a draft has never been in front of a child — sets accept only published
problems — so its rows are not history, they are an unsaved page. Published problems are
never written here at all; they change by new version (see `models/problems.py`).

**Publishing is checked twice.** The checks here are structural: a solution, at least one
test, a primary concept, on every leaf. Whether the solution actually *passes* its tests
can only be known by running Python, which this server does not do (spec §5.1) — the
teacher's browser runs them, and the publish route requires proof that it did so against
the version being published.
"""

import re
import uuid
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator, model_validator
from sqlmodel import col, delete, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import Principal
from app.models import Hint, Item, ItemConcept, ItemStatus, TestCase, TestKind
from app.models.base import utcnow
from app.scoping import list_item_parts, list_visible_concepts

MAX_TITLE_LENGTH = 120
MAX_PROMPT_CHARS = 20_000
# The same cap as a student's file: a reference solution is a child-sized program.
MAX_CODE_CHARS = 64 * 1024
MAX_TEST_TEXT = 10_000
MAX_TESTS = 30
MAX_PARTS = 6
PART_LABEL = re.compile(r"^[a-f]$")


# --- the document -------------------------------------------------------------------


class IoTest(BaseModel):
    """Feed `stdin` to the program, compare what it prints with `expected`.

    `exact` ignores trailing whitespace on each line and trailing blank lines — a child
    failing a test over a stray space learns nothing about Python. `contains` passes when
    `expected` appears anywhere in the output.
    """

    kind: Literal["io"] = "io"
    name: str = Field(min_length=1, max_length=120)
    hidden: bool = False
    stdin: str = Field(default="", max_length=MAX_TEST_TEXT)
    expected: str = Field(max_length=MAX_TEST_TEXT)
    match: Literal["exact", "contains"] = "exact"


class FunctionTest(BaseModel):
    """Run the program, then evaluate `call` and compare it with `expected` using `==`.

    Both are Python expressions: `call="add(2, 3)"`, `expected="5"`.
    """

    kind: Literal["function"]
    name: str = Field(min_length=1, max_length=120)
    hidden: bool = False
    call: str = Field(min_length=1, max_length=MAX_TEST_TEXT)
    expected: str = Field(min_length=1, max_length=MAX_TEST_TEXT)


TestDoc = Annotated[IoTest | FunctionTest, Field(discriminator="kind")]


class HintDoc(BaseModel):
    """One rung. Unlocks when either threshold is met; zero for both means "always open"."""

    body_md: str = Field(min_length=1, max_length=MAX_PROMPT_CHARS)
    unlock_after_runs: int = Field(default=1, ge=0, le=50)
    unlock_after_seconds: int = Field(default=120, ge=0, le=3600)


class LeafDoc(BaseModel):
    """What every attemptable thing carries — a problem without parts, or one part."""

    difficulty: int = Field(default=1, ge=1, le=3)
    concept_ids: list[uuid.UUID] = Field(default_factory=list, max_length=18)
    primary_concept_id: uuid.UUID | None = None
    starter_code: str = Field(default="", max_length=MAX_CODE_CHARS)
    solution_code: str = Field(default="", max_length=MAX_CODE_CHARS)
    tests: list[TestDoc] = Field(default_factory=list, max_length=MAX_TESTS)
    hints: list[HintDoc] = Field(default_factory=list, max_length=3)

    @model_validator(mode="after")
    def _primary_is_one_of_the_tags(self) -> "LeafDoc":
        if self.primary_concept_id is not None and self.primary_concept_id not in self.concept_ids:
            raise ValueError("The main concept must be one of the problem's concepts")
        if len(set(self.concept_ids)) != len(self.concept_ids):
            raise ValueError("A concept is listed twice")
        return self


class PartDoc(LeafDoc):
    label: str
    prompt_md: str = Field(default="", max_length=MAX_PROMPT_CHARS)

    @field_validator("label")
    @classmethod
    def _label_is_a_letter(cls, value: str) -> str:
        value = value.strip().lower()
        if not PART_LABEL.match(value):
            raise ValueError("Part labels are single letters, a to f")
        return value


class ProblemDoc(LeafDoc):
    title: str = Field(min_length=1, max_length=MAX_TITLE_LENGTH)
    prompt_md: str = Field(default="", max_length=MAX_PROMPT_CHARS)
    parts: list[PartDoc] = Field(default_factory=list, max_length=MAX_PARTS)

    @model_validator(mode="after")
    def _labels_are_unique(self) -> "ProblemDoc":
        labels = [part.label for part in self.parts]
        if len(set(labels)) != len(labels):
            raise ValueError("Two parts share a label")
        return self


# --- reading ------------------------------------------------------------------------


def _test_doc(row: TestCase) -> IoTest | FunctionTest:
    if row.kind == TestKind.IO:
        return IoTest(name=row.name, hidden=row.hidden, **row.spec)
    return FunctionTest(kind="function", name=row.name, hidden=row.hidden, **row.spec)


async def _leaf_children(
    session: AsyncSession, item_ids: list[uuid.UUID]
) -> tuple[dict, dict, dict]:
    """Tests, hints and tags for several items at once, keyed by item id.

    The items have already come through scoping; their child rows are reached only by
    item id, which is the boundary.
    """
    tests: dict[uuid.UUID, list[TestCase]] = {i: [] for i in item_ids}
    hints: dict[uuid.UUID, list[Hint]] = {i: [] for i in item_ids}
    tags: dict[uuid.UUID, list[ItemConcept]] = {i: [] for i in item_ids}
    if not item_ids:
        return tests, hints, tags
    for row in (
        await session.exec(
            select(TestCase)
            .where(col(TestCase.item_id).in_(item_ids))
            .order_by(col(TestCase.sort_order))
        )
    ).all():
        tests[row.item_id].append(row)
    for row in (
        await session.exec(
            select(Hint).where(col(Hint.item_id).in_(item_ids)).order_by(col(Hint.level))
        )
    ).all():
        hints[row.item_id].append(row)
    for row in (
        await session.exec(select(ItemConcept).where(col(ItemConcept.item_id).in_(item_ids)))
    ).all():
        tags[row.item_id].append(row)
    return tests, hints, tags


def _leaf_fields(item: Item, tests: list, hints: list, tags: list) -> dict:
    primary = next((t.concept_id for t in tags if t.is_primary), None)
    return {
        "difficulty": item.difficulty,
        "concept_ids": sorted(t.concept_id for t in tags),
        "primary_concept_id": primary,
        "starter_code": item.starter_code,
        "solution_code": item.solution_code,
        "tests": [_test_doc(t) for t in tests],
        "hints": [
            HintDoc(
                body_md=h.body_md,
                unlock_after_runs=h.unlock_after_runs,
                unlock_after_seconds=h.unlock_after_seconds,
            )
            for h in hints
        ],
    }


async def read_document(
    session: AsyncSession, principal: Principal, item: Item
) -> tuple[ProblemDoc, list[Item]]:
    """The whole problem as a document, plus its part rows (for their ids)."""
    parts = list(await list_item_parts(session, principal, item.id))
    tests, hints, tags = await _leaf_children(session, [item.id, *(p.id for p in parts)])
    doc = ProblemDoc(
        title=item.title,
        prompt_md=item.prompt_md,
        parts=[
            PartDoc(
                label=part.part_label or "",
                prompt_md=part.prompt_md,
                **_leaf_fields(part, tests[part.id], hints[part.id], tags[part.id]),
            )
            for part in parts
        ],
        **_leaf_fields(item, tests[item.id], hints[item.id], tags[item.id]),
    )
    return doc, parts


# --- writing ------------------------------------------------------------------------


class UnavailableConcept(ValueError):
    """A concept id the centre cannot see — another centre's, archived, or made up."""


async def check_concepts(session: AsyncSession, principal: Principal, doc: ProblemDoc) -> None:
    wanted = set(doc.concept_ids).union(*(part.concept_ids for part in doc.parts))
    visible = {c.id for c in await list_visible_concepts(session, principal)}
    if not wanted <= visible:
        raise UnavailableConcept


async def _replace_leaf(
    session: AsyncSession, centre_id: uuid.UUID, item: Item, leaf: LeafDoc
) -> None:
    item.difficulty = leaf.difficulty
    item.starter_code = leaf.starter_code
    item.solution_code = leaf.solution_code
    await _delete_children(session, [item.id])
    for order, test in enumerate(leaf.tests):
        session.add(
            TestCase(
                centre_id=centre_id,
                item_id=item.id,
                name=test.name.strip(),
                kind=TestKind(test.kind),
                spec=test.model_dump(exclude={"kind", "name", "hidden"}),
                hidden=test.hidden,
                sort_order=order,
            )
        )
    for level, hint in enumerate(leaf.hints, start=1):
        session.add(
            Hint(
                centre_id=centre_id,
                item_id=item.id,
                level=level,
                body_md=hint.body_md,
                unlock_after_runs=hint.unlock_after_runs,
                unlock_after_seconds=hint.unlock_after_seconds,
            )
        )
    for concept_id in leaf.concept_ids:
        session.add(
            ItemConcept(
                item_id=item.id,
                concept_id=concept_id,
                is_primary=concept_id == leaf.primary_concept_id,
            )
        )


async def _delete_children(session: AsyncSession, item_ids: list[uuid.UUID]) -> None:
    for model in (TestCase, Hint, ItemConcept):
        await session.exec(delete(model).where(col(model.item_id).in_(item_ids)))  # type: ignore[call-overload]


async def write_document(
    session: AsyncSession, principal: Principal, item: Item, doc: ProblemDoc
) -> None:
    """Write a document over a draft (or a freshly added, flushed item).

    Parts are matched by label, so a part keeps its id across saves for as long as its
    letter does. The caller has checked the item is a draft and owns the transaction.
    """
    item.title = doc.title.strip()
    item.prompt_md = doc.prompt_md
    # Set by hand, not left to `onupdate`: a save that only changes a test case does not
    # touch this row, and `updated_at` is what the publish route checks a test run against.
    item.updated_at = utcnow()
    await _replace_leaf(session, item.centre_id, item, doc)

    existing = {p.part_label: p for p in await list_item_parts(session, principal, item.id)}
    for order, part_doc in enumerate(doc.parts):
        part = existing.pop(part_doc.label, None)
        if part is None:
            part = Item(
                centre_id=item.centre_id,
                kind=item.kind,
                parent_id=item.id,
                part_label=part_doc.label,
                title="",
                status=item.status,
                version=item.version,
                created_by=item.created_by,
            )
            session.add(part)
            await session.flush()
        part.title = f"{item.title} ({part_doc.label})"
        part.prompt_md = part_doc.prompt_md
        part.sort_order = order
        await _replace_leaf(session, item.centre_id, part, part_doc)
        session.add(part)

    removed = [p.id for p in existing.values()]
    if removed:
        await _delete_children(session, removed)
        await session.exec(delete(Item).where(col(Item.id).in_(removed)))  # type: ignore[call-overload]
    session.add(item)


# --- publishing ---------------------------------------------------------------------


def publish_problems(doc: ProblemDoc) -> list[str]:
    """Why this document cannot be published yet, in words a teacher can act on.

    Empty means it can. Written as a list rather than raising on the first problem, so the
    editor can show every gap at once instead of one per click.
    """
    problems: list[str] = []

    def check_leaf(leaf: LeafDoc, where: str) -> None:
        if not leaf.solution_code.strip():
            problems.append(f"{where} needs a reference solution")
        if not leaf.tests:
            problems.append(f"{where} needs at least one test")
        if leaf.primary_concept_id is None:
            problems.append(f"{where} needs a main concept")

    if doc.parts:
        if doc.tests or doc.solution_code.strip():
            problems.append("A problem with parts keeps its tests and solution on the parts")
        for part in doc.parts:
            check_leaf(part, f"Part ({part.label})")
    else:
        check_leaf(doc, "The problem")
    return problems


async def set_status(
    session: AsyncSession, principal: Principal, item: Item, status: ItemStatus
) -> None:
    """Move a problem and all of its parts to `status` together."""
    item.status = status
    session.add(item)
    for part in await list_item_parts(session, principal, item.id):
        part.status = status
        session.add(part)
