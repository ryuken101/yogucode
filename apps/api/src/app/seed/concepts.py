"""Load the concept taxonomy from YAML into the `concepts` table.

The taxonomy is data, not code (product-spec §10): re-pointing the product at a different
course must be an edit to `concepts.yaml` and a re-run of this loader, never a migration.
That is why this exists in Phase 1 at all, months before anything reads a concept — the
content is deferred but the mechanism is cheap now and miserable to retrofit.

Three properties this loader has to have, in order of how much trouble each avoids:

- **Idempotent.** It will be run by hand, repeatedly, against a database that already has
  rows. Running it twice must be indistinguishable from running it once.
- **Quiet when nothing changed.** `TimestampMixin` sets `onupdate=utcnow`, so writing a
  row back unchanged bumps `updated_at` and makes the table look touched. Rows are only
  written when a field actually differs, which is also what makes the counts meaningful.
- **Archive, never delete.** A key that disappears from the YAML is archived. From Phase 6
  attempts and mastery rows will reference these ids; deleting one would orphan them, and
  a taxonomy edit is not a reason to lose history.

Seeded concepts are **global** (`centre_id IS NULL`). A centre can later override a key
with its own row — `uq_concepts_centre_key` permits that, and this loader never touches a
row that belongs to a centre.
"""

import asyncio
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import yaml
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import Concept, ConceptStatus

TAXONOMY_PATH = Path(__file__).parent / "concepts.yaml"


class TaxonomyError(Exception):
    """The YAML is not a usable taxonomy. Raised before anything is written."""


@dataclass(frozen=True, slots=True)
class ConceptSpec:
    """One concept from the file, with its nesting already resolved to a parent key."""

    key: str
    label: str
    sort_order: int
    parent_key: str | None = None


@dataclass(frozen=True, slots=True)
class SeedResult:
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    archived: int = 0

    def summary(self) -> str:
        return (
            f"{self.created} created, {self.updated} updated, "
            f"{self.unchanged} unchanged, {self.archived} archived"
        )


def load_taxonomy(path: Path = TAXONOMY_PATH) -> list[ConceptSpec]:
    """Parse the YAML, flattening any `children:` nesting into parent keys.

    `sort_order` defaults to the position in the file when a concept omits it, so a hand
    written taxonomy does not have to number itself to stay in order.
    """
    document = yaml.safe_load(path.read_text()) or {}
    entries = document.get("concepts")
    if not isinstance(entries, list) or not entries:
        raise TaxonomyError(f"{path} has no 'concepts' list")

    specs: list[ConceptSpec] = []
    seen: set[str] = set()

    def walk(nodes: list, parent_key: str | None, depth: int) -> None:
        if depth > 5:  # a self-referential FK with no depth limit is a way to hang a seed
            raise TaxonomyError("taxonomy is nested more than 5 deep")
        for position, node in enumerate(nodes, start=1):
            if not isinstance(node, dict):
                raise TaxonomyError(f"expected a mapping, got {node!r}")
            key, label = node.get("key"), node.get("label")
            if not key or not label:
                raise TaxonomyError(f"concept needs both key and label: {node!r}")
            if key in seen:
                raise TaxonomyError(f"duplicate key in taxonomy: {key!r}")
            seen.add(key)
            specs.append(
                ConceptSpec(
                    key=str(key),
                    label=str(label),
                    sort_order=int(node.get("sort_order", position * 10)),
                    parent_key=parent_key,
                )
            )
            children = node.get("children") or []
            if children:
                walk(children, str(key), depth + 1)

    walk(entries, None, 1)
    return specs


async def seed_concepts(session: AsyncSession, specs: Sequence[ConceptSpec]) -> SeedResult:
    """Apply a taxonomy to the global concepts, and report what changed.

    Takes a session rather than making one: the caller owns the transaction. That is what
    lets the tests run this inside the fixture's rolled-back transaction instead of
    leaving rows behind in the test database.

    Parents are resolved in a second pass, so a file may reference a parent defined after
    its child. `ON CONFLICT` is deliberately not used here — global uniqueness is enforced
    by a *partial* index (`uq_concepts_global_key ... WHERE centre_id IS NULL`, because
    Postgres treats NULLs as distinct), so an upsert would have to target the index
    predicate rather than the constraint. Reading first is clearer and is what makes
    created/updated/unchanged distinguishable at all.
    """
    existing = {
        concept.key: concept
        for concept in (
            await session.exec(select(Concept).where(Concept.centre_id.is_(None)))  # type: ignore[union-attr]
        ).all()
    }

    # Create the missing rows first, without parents, so that a file may name a parent
    # that is defined after its child. Ids only exist after the flush below.
    by_key: dict[str, Concept] = {}
    fresh: set[str] = set()
    for spec in specs:
        concept = existing.get(spec.key)
        if concept is None:
            concept = Concept(
                key=spec.key,
                label=spec.label,
                sort_order=spec.sort_order,
                status=ConceptStatus.PROVISIONAL,
            )
            session.add(concept)
            fresh.add(spec.key)
        by_key[spec.key] = concept
    await session.flush()

    # Now every id exists, so the full desired state of a row is knowable and each one can
    # be classified exactly once.
    created = updated = unchanged = 0
    for spec in specs:
        concept = by_key[spec.key]
        parent_id = by_key[spec.parent_key].id if spec.parent_key else None

        if spec.key in fresh:
            concept.parent_id = parent_id
            created += 1
            continue

        # Only write when something actually differs, or onupdate bumps updated_at on
        # every run and the table stops telling you when it was last really changed.
        differs = (
            concept.label != spec.label
            or concept.sort_order != spec.sort_order
            or concept.parent_id != parent_id
            or concept.status == ConceptStatus.ARCHIVED
        )
        if not differs:
            unchanged += 1
            continue

        concept.label = spec.label
        concept.sort_order = spec.sort_order
        concept.parent_id = parent_id
        if concept.status == ConceptStatus.ARCHIVED:
            # It is back in the file, so it is back in the taxonomy.
            concept.status = ConceptStatus.PROVISIONAL
        session.add(concept)
        updated += 1

    archived = 0
    wanted = {spec.key for spec in specs}
    for key, concept in existing.items():
        if key not in wanted and concept.status != ConceptStatus.ARCHIVED:
            concept.status = ConceptStatus.ARCHIVED
            session.add(concept)
            archived += 1

    await session.flush()
    return SeedResult(created=created, updated=updated, unchanged=unchanged, archived=archived)


async def _run() -> SeedResult:
    # Imported here so the module can be imported (and tested) without building an engine.
    from app.db import async_session_factory

    specs = load_taxonomy()
    async with async_session_factory() as session:
        result = await seed_concepts(session, specs)
        await session.commit()
    return result


def main() -> None:
    """`uv run seed-concepts`. Run it twice; the second run should change nothing."""
    try:
        result = asyncio.run(_run())
    except TaxonomyError as exc:
        print(f"taxonomy not loaded: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
    print(f"concepts: {result.summary()}")
