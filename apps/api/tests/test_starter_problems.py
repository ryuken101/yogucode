"""The starter pack is correct: every reference solution passes every one of its tests.

The grader that decides this is the real one — `apps/web/src/runtime/grader.py`, which
is plain standard-library Python and so runs under CPython as well as under Pyodide.
That makes a wrong `prints:` in the YAML a failing test here rather than a teacher
discovering it when "Check & publish all" refuses the problem, or a child discovering it
when a correct answer will not pass.
"""

import importlib.util
import json
import uuid
from pathlib import Path

import pytest

from app.problem_bank import LeafDoc, publish_problems
from app.problem_import import parse_file, to_document

STARTER = Path(__file__).resolve().parents[1] / "src" / "app" / "seed" / "starter-problems.yaml"
GRADER = Path(__file__).resolve().parents[2] / "web" / "src" / "runtime" / "grader.py"
CONCEPTS = Path(__file__).resolve().parents[1] / "src" / "app" / "seed" / "concepts.yaml"


def _load_grader():
    spec = importlib.util.spec_from_file_location("_grader", GRADER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _concept_ids() -> dict[str, uuid.UUID]:
    import yaml

    keys = [node["key"] for node in yaml.safe_load(CONCEPTS.read_text())["concepts"]]
    return {key: uuid.uuid5(uuid.NAMESPACE_URL, key) for key in keys}


def _leaves(doc):
    return doc.parts or [doc]


def _checks(leaf: LeafDoc) -> str:
    return json.dumps([test.model_dump() | {"hidden": False} for test in leaf.tests])


PROBLEMS = parse_file(STARTER.read_text()).problems


@pytest.mark.parametrize("entry", PROBLEMS, ids=[p.key for p in PROBLEMS])
def test_the_reference_solution_passes_every_test(entry) -> None:
    grader = _load_grader()
    doc = to_document(entry, _concept_ids())
    for leaf in _leaves(doc):
        run = json.loads(grader.run_tests(leaf.solution_code, _checks(leaf)))
        assert run["compile_error"] is None
        failures = [r for r in run["results"] if not r["passed"]]
        assert failures == [], failures


@pytest.mark.parametrize("entry", PROBLEMS, ids=[p.key for p in PROBLEMS])
def test_the_starter_code_does_not_already_pass(entry) -> None:
    """A problem a child solves by pressing Check on the starter code teaches nothing."""
    grader = _load_grader()
    doc = to_document(entry, _concept_ids())
    for leaf in _leaves(doc):
        run = json.loads(grader.run_tests(leaf.starter_code, _checks(leaf)))
        assert not all(r["passed"] for r in run["results"])


@pytest.mark.parametrize("entry", PROBLEMS, ids=[p.key for p in PROBLEMS])
def test_every_problem_is_ready_to_publish(entry) -> None:
    assert publish_problems(to_document(entry, _concept_ids())) == []
