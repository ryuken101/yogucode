"""The concept taxonomy loader.

The content in `concepts.yaml` is provisional and will be replaced when Magikid's scope
and sequence arrives. The *mechanism* is what these tests protect: that swapping the file
and re-running the loader is enough, which is product-spec §10's "can you configure the
product for the VEX IQ course without changing code?" test.

Nesting is proved against a synthetic taxonomy rather than the real one, because the real
one is deliberately flat — grouping the spec's 18 tags into strands would be inventing
curriculum content that Phase 0 deferred.
"""

from pathlib import Path

import pytest
import yaml
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import Centre, Concept, ConceptStatus
from app.seed.concepts import (
    TAXONOMY_PATH,
    ConceptSpec,
    TaxonomyError,
    load_taxonomy,
    seed_concepts,
)


def write_taxonomy(tmp_path: Path, document: dict) -> Path:
    path = tmp_path / "concepts.yaml"
    path.write_text(yaml.safe_dump(document))
    return path


async def global_concepts(session: AsyncSession) -> list[Concept]:
    found = (
        await session.exec(
            select(Concept).where(Concept.centre_id.is_(None)).order_by(Concept.sort_order)  # type: ignore[union-attr]
        )
    ).all()
    return list(found)


# --- the shipped taxonomy -----------------------------------------------------------


def test_the_shipped_taxonomy_holds_the_eighteen_tags_from_the_spec() -> None:
    """product-spec §3.7 says 12-18 tags and lists 18. Guards the file itself."""
    specs = load_taxonomy()
    assert len(specs) == 18
    assert len({spec.key for spec in specs}) == 18
    assert all(spec.parent_key is None for spec in specs), "the shipped list is flat"


def test_the_shipped_taxonomy_is_ordered_and_gapped() -> None:
    """Spaced by ten so a tag can be inserted without renumbering the file."""
    orders = [spec.sort_order for spec in load_taxonomy()]
    assert orders == sorted(orders)
    assert len(set(orders)) == len(orders)


async def test_seeding_the_shipped_taxonomy(session: AsyncSession) -> None:
    result = await seed_concepts(session, load_taxonomy())

    assert (result.created, result.updated, result.unchanged, result.archived) == (18, 0, 0, 0)
    concepts = await global_concepts(session)
    assert len(concepts) == 18
    # Provisional, out loud: the content is a placeholder until the scope and sequence
    # is confirmed.
    assert all(c.status == ConceptStatus.PROVISIONAL for c in concepts)
    assert all(c.centre_id is None for c in concepts)
    assert concepts[0].key == "variables"


# --- idempotency --------------------------------------------------------------------


async def test_a_second_run_changes_nothing(session: AsyncSession) -> None:
    specs = load_taxonomy()
    await seed_concepts(session, specs)

    again = await seed_concepts(session, specs)
    assert (again.created, again.updated, again.archived) == (0, 0, 0)
    assert again.unchanged == 18
    assert len(await global_concepts(session)) == 18


async def test_a_no_op_run_does_not_bump_updated_at(session: AsyncSession) -> None:
    """onupdate=utcnow fires on any write, so an unchanged row must not be written."""
    specs = load_taxonomy()
    await seed_concepts(session, specs)
    before = {c.key: c.updated_at for c in await global_concepts(session)}

    await seed_concepts(session, specs)
    after = {c.key: c.updated_at for c in await global_concepts(session)}
    assert before == after


# --- editing the taxonomy -----------------------------------------------------------


async def test_a_changed_label_updates_only_that_row(session: AsyncSession) -> None:
    specs = load_taxonomy()
    await seed_concepts(session, specs)

    edited = [
        ConceptSpec(key=s.key, label="Loops, for", sort_order=s.sort_order)
        if s.key == "for_loops"
        else s
        for s in specs
    ]
    result = await seed_concepts(session, edited)

    assert (result.created, result.updated, result.unchanged) == (0, 1, 17)
    renamed = next(c for c in await global_concepts(session) if c.key == "for_loops")
    assert renamed.label == "Loops, for"


async def test_a_new_key_is_created_alongside_the_rest(session: AsyncSession) -> None:
    specs = load_taxonomy()
    await seed_concepts(session, specs)

    result = await seed_concepts(
        session, [*specs, ConceptSpec(key="dictionaries", label="Dictionaries", sort_order=190)]
    )
    assert (result.created, result.unchanged) == (1, 18)


async def test_a_removed_key_is_archived_not_deleted(session: AsyncSession) -> None:
    """Attempts and mastery will reference these ids from Phase 6; nothing is deleted."""
    specs = load_taxonomy()
    await seed_concepts(session, specs)

    without_turtle = [s for s in specs if s.key != "turtle_basics"]
    result = await seed_concepts(session, without_turtle)

    assert result.archived == 1
    concepts = await global_concepts(session)
    assert len(concepts) == 18, "archived, not deleted"
    turtle = next(c for c in concepts if c.key == "turtle_basics")
    assert turtle.status == ConceptStatus.ARCHIVED


async def test_archiving_is_itself_idempotent(session: AsyncSession) -> None:
    specs = load_taxonomy()
    await seed_concepts(session, specs)
    without_turtle = [s for s in specs if s.key != "turtle_basics"]
    await seed_concepts(session, without_turtle)

    again = await seed_concepts(session, without_turtle)
    assert again.archived == 0
    assert again.unchanged == 17


async def test_a_key_returning_to_the_file_is_revived(session: AsyncSession) -> None:
    specs = load_taxonomy()
    await seed_concepts(session, specs)
    await seed_concepts(session, [s for s in specs if s.key != "turtle_basics"])

    result = await seed_concepts(session, specs)
    assert result.updated == 1
    turtle = next(c for c in await global_concepts(session) if c.key == "turtle_basics")
    assert turtle.status == ConceptStatus.PROVISIONAL


# --- a centre's own concepts are not the loader's business ---------------------------


async def test_a_centres_own_concept_is_left_alone(session: AsyncSession) -> None:
    """uq_concepts_centre_key lets a centre override a global key; the seed must not
    touch that row, nor archive it when the global key disappears."""
    centre = Centre(name="Magikid Castle Hill", slug="castle-hill")
    session.add(centre)
    await session.flush()
    session.add(Concept(centre_id=centre.id, key="for_loops", label="For loops, Castle Hill"))
    await session.flush()

    await seed_concepts(session, load_taxonomy())

    override = (await session.exec(select(Concept).where(Concept.centre_id == centre.id))).one()
    assert override.label == "For loops, Castle Hill"
    assert len(await global_concepts(session)) == 18


# --- the mechanism: a different course, no code change -------------------------------


async def test_a_nested_taxonomy_produces_parent_links(
    session: AsyncSession, tmp_path: Path
) -> None:
    """The VEX IQ test. A hierarchy must need a file edit, not a migration."""
    path = write_taxonomy(
        tmp_path,
        {
            "concepts": [
                {
                    "key": "drivetrain",
                    "label": "Drivetrain",
                    "sort_order": 10,
                    "children": [
                        {"key": "gear_ratios", "label": "Gear ratios", "sort_order": 20},
                        {"key": "turning", "label": "Turning", "sort_order": 30},
                    ],
                },
                {"key": "sensors", "label": "Sensors", "sort_order": 40},
            ]
        },
    )

    specs = load_taxonomy(path)
    assert [s.parent_key for s in specs] == [None, "drivetrain", "drivetrain", None]

    await seed_concepts(session, specs)
    concepts = {c.key: c for c in await global_concepts(session)}
    assert len(concepts) == 4
    assert concepts["gear_ratios"].parent_id == concepts["drivetrain"].id
    assert concepts["sensors"].parent_id is None


async def test_a_parent_may_be_defined_after_its_child(
    session: AsyncSession, tmp_path: Path
) -> None:
    """Parents are resolved after every row has an id, so file order does not matter."""
    path = write_taxonomy(
        tmp_path,
        {
            "concepts": [
                {"key": "loops", "label": "Loops", "children": [{"key": "for_", "label": "For"}]}
            ]
        },
    )
    await seed_concepts(session, load_taxonomy(path))

    concepts = {c.key: c for c in await global_concepts(session)}
    assert concepts["for_"].parent_id == concepts["loops"].id


async def test_reparenting_counts_as_an_update(session: AsyncSession, tmp_path: Path) -> None:
    flat = write_taxonomy(
        tmp_path, {"concepts": [{"key": "a", "label": "A"}, {"key": "b", "label": "B"}]}
    )
    await seed_concepts(session, load_taxonomy(flat))

    nested = write_taxonomy(
        tmp_path,
        {"concepts": [{"key": "a", "label": "A", "children": [{"key": "b", "label": "B"}]}]},
    )
    result = await seed_concepts(session, load_taxonomy(nested))

    assert result.updated == 1
    concepts = {c.key: c for c in await global_concepts(session)}
    assert concepts["b"].parent_id == concepts["a"].id


async def test_sort_order_defaults_to_file_position(tmp_path: Path) -> None:
    path = write_taxonomy(
        tmp_path, {"concepts": [{"key": "a", "label": "A"}, {"key": "b", "label": "B"}]}
    )
    assert [s.sort_order for s in load_taxonomy(path)] == [10, 20]


# --- a bad file is refused before anything is written --------------------------------


async def test_a_duplicate_key_is_refused(tmp_path: Path) -> None:
    path = write_taxonomy(
        tmp_path, {"concepts": [{"key": "a", "label": "A"}, {"key": "a", "label": "Again"}]}
    )
    with pytest.raises(TaxonomyError, match="duplicate key"):
        load_taxonomy(path)


async def test_a_concept_without_a_label_is_refused(tmp_path: Path) -> None:
    path = write_taxonomy(tmp_path, {"concepts": [{"key": "a"}]})
    with pytest.raises(TaxonomyError, match="key and label"):
        load_taxonomy(path)


async def test_an_empty_file_is_refused(tmp_path: Path) -> None:
    path = write_taxonomy(tmp_path, {"concepts": []})
    with pytest.raises(TaxonomyError, match="no 'concepts' list"):
        load_taxonomy(path)


def test_the_taxonomy_path_points_at_the_shipped_file() -> None:
    assert TAXONOMY_PATH.name == "concepts.yaml"
    assert TAXONOMY_PATH.is_file()
