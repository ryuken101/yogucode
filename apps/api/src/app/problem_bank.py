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

**Example transcripts are written at publish, never at save.** The teacher gives the
inputs; what the solution printed with them is only known after the browser runs it, and
writing it back with a save would move `updated_at` and make that very run stale. So a
save keeps the inputs and drops any transcript, and the publish route stores the
transcripts its browser run produced (`apply_transcripts`).
"""

import base64
import re
import uuid
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator, model_validator
from sqlmodel import col, delete, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import Principal
from app.models import Hint, Item, ItemConcept, ItemKind, ItemStatus, TestCase, TestKind
from app.models.base import utcnow
from app.scoping import list_item_parts, list_visible_concepts

MAX_TITLE_LENGTH = 120
MAX_PROMPT_CHARS = 20_000
# The same cap as a student's file: a reference solution is a child-sized program.
MAX_CODE_CHARS = 64 * 1024
MAX_TEST_TEXT = 10_000
MAX_TESTS = 30
MAX_PARTS = 6
MAX_EXAMPLES = 3
MAX_EXAMPLE_INPUTS = 20
MAX_TRANSCRIPT_LINES = 400
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


class ScriptTest(BaseModel):
    """The teacher's own Python check (17 Oct 2026), for what a fixed expected value cannot
    say — a check that depends on values the child chose.

    `code` gets `run(*inputs)`, which runs the child's program and returns `(output,
    variables)`, and `check(condition, message)`. See `runtime/grader.py`.
    """

    kind: Literal["script"]
    name: str = Field(min_length=1, max_length=120)
    hidden: bool = False
    code: str = Field(min_length=1, max_length=MAX_TEST_TEXT)


class RangeInput(BaseModel):
    """Every whole number from `start` to `end`, inclusive."""

    mode: Literal["range"]
    start: int = Field(ge=-1_000_000, le=1_000_000)
    end: int = Field(ge=-1_000_000, le=1_000_000)

    @model_validator(mode="after")
    def _small(self) -> "RangeInput":
        if not 0 <= self.end - self.start < 100:
            raise ValueError("A range runs upwards and tries at most 100 values")
        return self


class ValuesInput(BaseModel):
    mode: Literal["values"]
    values: list[Annotated[str, Field(max_length=200)]] = Field(min_length=1, max_length=50)


class RandomInput(BaseModel):
    """`count` whole numbers picked from `start`..`end` — the same ones on every press."""

    mode: Literal["random"]
    count: int = Field(ge=1, le=50)
    start: int = Field(ge=-1_000_000, le=1_000_000)
    end: int = Field(ge=-1_000_000, le=1_000_000)


CompareInput = Annotated[RangeInput | ValuesInput | RandomInput, Field(discriminator="mode")]


class NoRule(BaseModel):
    type: Literal["none"]


class NumberRule(BaseModel):
    type: Literal["number"]
    min: int = 0
    max: int = 9


class NumbersRule(BaseModel):
    type: Literal["numbers"]
    count: int | None = Field(default=None, ge=0, le=100)
    min: int = 0
    max: int = 9
    distinct: bool = False


class ListRule(BaseModel):
    type: Literal["list"]
    min_length: int = Field(default=1, ge=0, le=100)


class TextRule(BaseModel):
    type: Literal["text"]


ChosenRule = Annotated[
    NoRule | NumberRule | NumbersRule | ListRule | TextRule, Field(discriminator="type")
]


class ChosenValue(BaseModel):
    """A value the child chooses in their own program (`ships`), and what it must be."""

    name: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]*$", max_length=60)
    rule: ChosenRule = Field(default_factory=lambda: NoRule(type="none"))


MAX_COMPARE_CASES = 200


class CompareTest(BaseModel):
    """ "Matches my solution" (Ken's decision, 17 Oct 2026): the child's program and the
    reference solution are run on every case, with the child's `chosen` values put into
    the solution, and their output compared. Correct checks for student-chosen data, with
    no code to write. See `runtime/grader.py`.

    `reference` is the scrambled solution, added only when the check is sent to a child's
    browser (`with_reference`) — never stored, and null in a teacher's document.
    """

    kind: Literal["compare"]
    name: str = Field(min_length=1, max_length=120)
    hidden: bool = False
    inputs: list[CompareInput] = Field(default_factory=list, max_length=4)
    chosen: list[ChosenValue] = Field(default_factory=list, max_length=4)
    match: Literal["exact", "contains"] = "exact"
    # Only ever set on the way to a child's browser; always None in what is stored or read.
    reference: str | None = None

    @model_validator(mode="after")
    def _few_enough_cases(self) -> "CompareTest":
        cases = 1
        for row in self.inputs:
            cases *= (
                row.end - row.start + 1
                if isinstance(row, RangeInput)
                else len(row.values)
                if isinstance(row, ValuesInput)
                else row.count
            )
        if cases > MAX_COMPARE_CASES:
            raise ValueError(
                f"A check tries at most {MAX_COMPARE_CASES} cases; this one has {cases}"
            )
        names = [c.name for c in self.chosen]
        if len(set(names)) != len(names):
            raise ValueError("A value is listed twice")
        return self


TestDoc = Annotated[IoTest | FunctionTest | ScriptTest | CompareTest, Field(discriminator="kind")]

# Not security: the solution has to reach the child's browser to be run. This keeps it from
# being readable at a glance. The same key is in `runtime/grader.py`.
SCRAMBLE_KEY = b"yogucode-matches-my-solution"


def scramble(text: str) -> str:
    data = text.encode()
    return base64.b64encode(
        bytes(b ^ SCRAMBLE_KEY[i % len(SCRAMBLE_KEY)] for i, b in enumerate(data))
    ).decode()


def with_reference(tests: list, solution: str) -> list:
    """A leaf's tests as a child's browser gets them: compare checks carry the solution,
    scrambled. Other kinds pass through unchanged."""
    return [
        test.model_copy(update={"reference": scramble(solution)})
        if isinstance(test, CompareTest)
        else test
        for test in tests
    ]


class HintDoc(BaseModel):
    """One rung. Unlocks when either threshold is met; zero for both means "always open"."""

    body_md: str = Field(min_length=1, max_length=MAX_PROMPT_CHARS)
    unlock_after_runs: int = Field(default=1, ge=0, le=50)
    unlock_after_seconds: int = Field(default=120, ge=0, le=3600)


class TranscriptLine(BaseModel):
    """One piece of a sample run: what the program printed, or what was typed in."""

    kind: Literal["out", "in"]
    text: str = Field(max_length=MAX_TEST_TEXT)


class ExampleDoc(BaseModel):
    """A sample run a child can watch. `inputs` are typed in order, one per `input()`.

    `transcript` is what the reference solution's run looked like, filled at publish; on a
    draft it is always None.
    """

    inputs: list[Annotated[str, Field(max_length=500)]] = Field(
        default_factory=list, max_length=MAX_EXAMPLE_INPUTS
    )
    transcript: list[TranscriptLine] | None = Field(default=None, max_length=MAX_TRANSCRIPT_LINES)


class LeafDoc(BaseModel):
    """What every attemptable thing carries — a problem without parts, or one part."""

    difficulty: int = Field(default=1, ge=1, le=3)
    concept_ids: list[uuid.UUID] = Field(default_factory=list, max_length=18)
    primary_concept_id: uuid.UUID | None = None
    starter_code: str = Field(default="", max_length=MAX_CODE_CHARS)
    solution_code: str = Field(default="", max_length=MAX_CODE_CHARS)
    tests: list[TestDoc] = Field(default_factory=list, max_length=MAX_TESTS)
    hints: list[HintDoc] = Field(default_factory=list, max_length=3)
    examples: list[ExampleDoc] = Field(default_factory=list, max_length=MAX_EXAMPLES)

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


class OptionDoc(BaseModel):
    """One answer to a multiple-choice question.

    A wrong option should name the wrong belief that leads to it — "thinks range includes
    the end" — so a teacher can read the class's answers as a list of misconceptions
    (spec §3.6). Optional, because a teacher may not always know; publishing warns.
    """

    text: str = Field(min_length=1, max_length=2000)
    correct: bool = False
    misconception: str | None = Field(default=None, max_length=300)


MAX_OPTIONS = 8


class ProblemDoc(LeafDoc):
    kind: Literal["code", "mcq"] = "code"
    title: str = Field(min_length=1, max_length=MAX_TITLE_LENGTH)
    prompt_md: str = Field(default="", max_length=MAX_PROMPT_CHARS)
    parts: list[PartDoc] = Field(default_factory=list, max_length=MAX_PARTS)
    # One file for every part: the starter and solution here, each part's checks run
    # against all of it. Meaningless without parts.
    shared_file: bool = False
    # Multiple choice only.
    options: list[OptionDoc] = Field(default_factory=list, max_length=MAX_OPTIONS)

    @model_validator(mode="after")
    def _labels_are_unique(self) -> "ProblemDoc":
        labels = [part.label for part in self.parts]
        if len(set(labels)) != len(labels):
            raise ValueError("Two parts share a label")
        if self.kind == "mcq" and self.parts:
            raise ValueError("A multiple-choice question has no parts")
        return self


# --- reading ------------------------------------------------------------------------


def _test_doc(row: TestCase) -> IoTest | FunctionTest | ScriptTest | CompareTest:
    if row.kind == TestKind.IO:
        return IoTest(name=row.name, hidden=row.hidden, **row.spec)
    if row.kind == TestKind.SCRIPT:
        return ScriptTest(kind="script", name=row.name, hidden=row.hidden, **row.spec)
    if row.kind == TestKind.COMPARE:
        return CompareTest(kind="compare", name=row.name, hidden=row.hidden, **row.spec)
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
        "examples": [ExampleDoc(**example) for example in item.examples],
    }


async def read_document(
    session: AsyncSession, principal: Principal, item: Item
) -> tuple[ProblemDoc, list[Item]]:
    """The whole problem as a document, plus its part rows (for their ids)."""
    parts = list(await list_item_parts(session, principal, item.id))
    tests, hints, tags = await _leaf_children(session, [item.id, *(p.id for p in parts)])
    doc = ProblemDoc(
        kind=item.kind,
        title=item.title,
        prompt_md=item.prompt_md,
        shared_file=item.shared_file and bool(parts),
        options=[OptionDoc(**option) for option in item.options],
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
    # Inputs only: a transcript is proof of a run, and a save is not one.
    item.examples = [{"inputs": example.inputs, "transcript": None} for example in leaf.examples]
    await _delete_children(session, [item.id])
    for order, test in enumerate(leaf.tests):
        session.add(
            TestCase(
                centre_id=centre_id,
                item_id=item.id,
                name=test.name.strip(),
                kind=TestKind(test.kind),
                spec=test.model_dump(exclude={"kind", "name", "hidden", "reference"}),
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
    item.kind = ItemKind(doc.kind)
    item.shared_file = doc.shared_file and bool(doc.parts)
    item.options = [option.model_dump() for option in doc.options] if doc.kind == "mcq" else []
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

    if doc.kind == "mcq":
        if len(doc.options) < 2:
            problems.append("The question needs at least two options")
        if sum(1 for option in doc.options if option.correct) != 1:
            problems.append("Exactly one option should be marked correct")
        if doc.primary_concept_id is None:
            problems.append("The question needs a main concept")
        return problems

    def check_leaf(leaf: LeafDoc, where: str) -> None:
        if not leaf.solution_code.strip():
            problems.append(f"{where} needs a reference solution")
        if not leaf.tests:
            problems.append(f"{where} needs at least one test")
        if leaf.primary_concept_id is None:
            problems.append(f"{where} needs a main concept")

    if doc.parts and doc.shared_file:
        if not doc.solution_code.strip():
            problems.append("The file needs a reference solution")
        if doc.tests:
            problems.append("A problem with parts keeps its tests on the parts")
        for part in doc.parts:
            where = f"Part ({part.label})"
            if part.starter_code.strip() or part.solution_code.strip():
                problems.append(f"{where} shares the problem's file, so has no code of its own")
            if not part.tests:
                problems.append(f"{where} needs at least one test")
            if part.primary_concept_id is None:
                problems.append(f"{where} needs a main concept")
    elif doc.parts:
        if doc.tests or doc.solution_code.strip():
            problems.append("A problem with parts keeps its tests and solution on the parts")
        if doc.examples:
            problems.append("Examples go on the parts, since each part has its own code")
        for part in doc.parts:
            check_leaf(part, f"Part ({part.label})")
    else:
        check_leaf(doc, "The problem")
    return problems


def publish_warnings(doc: ProblemDoc) -> list[str]:
    """What is worth fixing but does not block publishing."""
    if doc.kind != "mcq":
        if doc.shared_file and any(t.kind == "io" for part in doc.parts for t in part.tests):
            return [
                "An output check on a part sees everything the whole file prints, other "
                "parts included — function checks suit a shared file better"
            ]
        return []
    unexplained = [
        option.text for option in doc.options if not option.correct and not option.misconception
    ]
    if unexplained:
        return [
            f"{len(unexplained)} wrong option{'s' if len(unexplained) != 1 else ''} "
            "without a misconception — naming it is what makes the answers diagnostic"
        ]
    return []


class TranscriptMismatch(ValueError):
    """Transcripts that do not fit the examples they claim to be runs of."""


def leaf_key(part: PartDoc | None) -> str:
    """How the editor and the publish route name a leaf: its label, or "" for the problem."""
    return part.label if part is not None else ""


async def apply_transcripts(
    session: AsyncSession,
    principal: Principal,
    item: Item,
    doc: ProblemDoc,
    transcripts: dict[str, list[list[TranscriptLine]]],
) -> None:
    """Store the browser's runs of each example on the rows being published.

    Every leaf with examples needs one transcript per example, and what was typed in a
    transcript must be the example's inputs, in order (a run may stop before using them
    all). Anything else is refused: it is a run of some other version of the examples.
    """
    rows = {"": item} | {
        part.part_label or "": part for part in await list_item_parts(session, principal, item.id)
    }
    leaves: list[tuple[str, LeafDoc]] = [("", doc)] + [(p.label, p) for p in doc.parts]
    expected = {key for key, leaf in leaves if leaf.examples}
    if set(transcripts) - expected or expected - set(transcripts):
        raise TranscriptMismatch
    for key, leaf in leaves:
        if not leaf.examples:
            continue
        runs = transcripts[key]
        if len(runs) != len(leaf.examples):
            raise TranscriptMismatch
        for example, run in zip(leaf.examples, runs, strict=True):
            typed = [line.text for line in run if line.kind == "in"]
            if typed != example.inputs[: len(typed)]:
                raise TranscriptMismatch
        row = rows[key]
        row.examples = [
            {"inputs": example.inputs, "transcript": [line.model_dump() for line in run]}
            for example, run in zip(leaf.examples, runs, strict=True)
        ]
        session.add(row)


async def set_status(
    session: AsyncSession, principal: Principal, item: Item, status: ItemStatus
) -> None:
    """Move a problem and all of its parts to `status` together."""
    item.status = status
    session.add(item)
    for part in await list_item_parts(session, principal, item.id):
        part.status = status
        session.add(part)
