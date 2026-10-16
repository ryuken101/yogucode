"""Run a student's program against a problem's test cases, inside Pyodide.

Loaded once into the worker as the module `_grader`, and called with the program and the
tests as JSON. It returns JSON. Python rather than JavaScript because the comparisons
are Python's — `==` on the value a function returned, `repr` of what it got — and doing
them anywhere else would be reimplementing Python's semantics badly.

Three properties matter more than the rest:

- **Every test runs in fresh globals.** One test's variables must not make another pass.
  The child's interactive session (`pyodide.globals`) is never touched either: pressing
  "Check" must not wipe the variables they were inspecting.
- **`input()` reads the test's stdin and its prompt is not captured.** So an io test's
  `expected` is what the program *prints*, and a teacher writing
  `name = input("Name? ")` does not have to put "Name? " in the expected output.
- **A custom check** (`script`, 17 Oct 2026) is Python the teacher wrote, for checks
  that depend on the child's own values — "for every guess, HIT! exactly when the guess is
  in *their* ships". It gets `run(*inputs)`, which runs the child's program fresh and
  returns `(output, variables)`, and `check(condition, message)`. A failure says the
  teacher's message and what that run printed.
- **A runaway loop fails one test, not the page.** A wall-clock deadline is checked from a
  trace function; the page's Stop button cannot help here, because it cannot know which
  test is running.
"""

import builtins
import contextlib
import io
import json
import sys
import time
import traceback

# Per test. Generous for a child's program on a slow laptop, short enough that a class's
# worth of "Check" presses on an infinite loop are not a wait.
TIME_LIMIT_SECONDS = 2.0
# What is shown back of the program's output. A test that prints 10,000 lines failed on
# line one; the rest is noise.
MAX_SHOWN_CHARS = 2000
FILENAME = "<your code>"


class TookTooLong(Exception):
    """Raised inside the student's program by the trace function."""


class AskedForInput(Exception):
    """A function test's program called input(); there is nothing to give it."""


def _deadline_tracer(deadline):
    counter = [0]

    def tracer(frame, event, arg):
        # Checking the clock on every line would slow the program for no gain; every few
        # hundred lines still catches `while True: pass` within milliseconds of the limit.
        counter[0] += 1
        if counter[0] % 256 == 0 and time.monotonic() > deadline:
            raise TookTooLong
        return tracer

    return tracer


def _normalise(text):
    """Trailing whitespace per line and trailing blank lines do not count."""
    lines = [line.rstrip() for line in text.replace("\r\n", "\n").split("\n")]
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def _shown(text):
    if len(text) <= MAX_SHOWN_CHARS:
        return text
    return text[:MAX_SHOWN_CHARS] + "\n…"


def _describe_error(error):
    """`NameError on line 3: name 'x' is not defined` — the line in *their* code."""
    line = None
    if isinstance(error, SyntaxError) and error.filename == FILENAME:
        line = error.lineno
    else:
        for frame in traceback.extract_tb(error.__traceback__):
            if frame.filename == FILENAME:
                line = frame.lineno
    name = type(error).__name__
    message = str(error)
    where = f" on line {line}" if line else ""
    return f"{name}{where}: {message}" if message else f"{name}{where}"


def _execute(code, stdin_text, function_test):
    """Run the program in fresh globals. Returns (namespace, stdout, error text or None)."""
    namespace = {"__name__": "__main__", "__builtins__": builtins}
    lines = io.StringIO(stdin_text)

    def fake_input(prompt=""):
        if function_test:
            raise AskedForInput
        line = lines.readline()
        if not line:
            raise EOFError("the program asked for more input than this test gives it")
        return line.rstrip("\n")

    namespace["input"] = fake_input
    captured = io.StringIO()
    error = None
    compiled = compile(code, FILENAME, "exec")
    sys.settrace(_deadline_tracer(time.monotonic() + TIME_LIMIT_SECONDS))
    try:
        with contextlib.redirect_stdout(captured):
            exec(compiled, namespace)
    except TookTooLong:
        error = "took too long — is there a loop that never ends?"
    except AskedForInput:
        error = "the program asked for input, but this check calls a function instead"
    except SystemExit:
        pass  # exit() ends a program normally; it is not a failure
    except KeyboardInterrupt:
        raise  # Stop from the page ends the whole check
    except Exception as exc:  # noqa: BLE001 — the student's error is the result
        error = _describe_error(exc)
    finally:
        sys.settrace(None)
    return namespace, captured.getvalue(), error


def _run_io(code, test):
    _, output, error = _execute(code, test.get("stdin", ""), function_test=False)
    got = _normalise(output)
    expected = _normalise(test["expected"])
    if test.get("match") == "contains":
        passed = expected in got
    else:
        passed = got == expected
    # A program that printed the right thing and *then* crashed has not passed.
    passed = passed and error is None
    return {"passed": passed, "got": _shown(got), "expected": expected, "error": error}


def _run_function(code, test):
    namespace, _, error = _execute(code, "", function_test=True)
    if error is not None:
        return {"passed": False, "error": error, "expected": test["expected"]}
    sys.settrace(_deadline_tracer(time.monotonic() + TIME_LIMIT_SECONDS))
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            got = eval(compile(test["call"], FILENAME, "eval"), namespace)
    except TookTooLong:
        return {"passed": False, "error": "took too long — is there a loop that never ends?"}
    except KeyboardInterrupt:
        raise
    except Exception as exc:  # noqa: BLE001
        return {"passed": False, "error": _describe_error(exc), "expected": test["expected"]}
    finally:
        sys.settrace(None)
    # `expected` is evaluated with nothing in scope: it is a value, not a program.
    try:
        expected_value = eval(test["expected"], {"__builtins__": {}})
    except Exception:  # noqa: BLE001 — the teacher's typo, reported as such
        return {
            "passed": False,
            "error": "this check's expected value is not valid Python — tell your teacher",
        }
    return {
        "passed": got == expected_value,
        "got": _shown(repr(got)),
        "expected": repr(expected_value),
        "error": None,
    }


# --- custom checks (17 Oct 2026) -----------------------------------------------------

# A whole custom check, across all its runs. Each run keeps its own TIME_LIMIT_SECONDS.
SCRIPT_TIME_LIMIT_SECONDS = 10.0
SCRIPT_MISTAKE = "This check has a mistake in it — tell your teacher"


class CheckFailed(Exception):
    """A case of a custom check did not hold. The message is the teacher's, for the child."""


class _Variables(dict):
    """The program's variables. Asking for one it does not have fails the check, in words
    a child can act on, rather than crashing the teacher's code with a KeyError."""

    def __missing__(self, name):
        raise CheckFailed(f"Your program has no variable called `{name}`")


def _variables(namespace):
    """The program's own values: no functions, classes, modules or `__dunder__` names."""
    import types

    return _Variables(
        {
            name: value
            for name, value in namespace.items()
            if not name.startswith("__")
            and name != "input"
            and not isinstance(value, (types.FunctionType, types.ModuleType, type))
        }
    )


def _run_script(code, test):
    """Run the teacher's check against the child's program."""
    state = {"got": None, "runs": 0}
    deadline = time.monotonic() + SCRIPT_TIME_LIMIT_SECONDS

    def run(*inputs):
        if time.monotonic() > deadline:
            raise CheckFailed("took too long — is there a loop that never ends?")
        stdin = "".join(f"{value}\n" for value in inputs)
        namespace, output, error = _execute(code, stdin, function_test=False)
        state["runs"] += 1
        state["got"] = _normalise(output)
        if error is not None:
            if error.startswith("EOFError"):
                error = "your program asked for more input than this check gives it"
            raise CheckFailed(error)
        return state["got"], _variables(namespace)

    def check(condition, message=""):
        if not condition:
            raise CheckFailed(str(message) or "This check did not hold")

    def contains(output, text):
        """Whether `text` is in `output`, ignoring case and spacing."""
        squash = lambda value: " ".join(str(value).split()).casefold()  # noqa: E731
        return squash(text) in squash(output)

    scope = {"__builtins__": builtins, "run": run, "check": check, "contains": contains}
    try:
        exec(compile(test["code"], "<check>", "exec"), scope)
    except CheckFailed as failed:
        result = {"passed": False, "error": str(failed)}
        if state["got"] is not None:
            result["got"] = _shown(state["got"])
        return result
    except KeyboardInterrupt:
        raise
    except Exception as exc:  # noqa: BLE001 — the teacher's mistake, not the child's
        detail = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
        if isinstance(exc, SyntaxError) and exc.lineno:
            detail = f"SyntaxError on line {exc.lineno} of the check: {exc.msg}"
        return {"passed": False, "error": detail if test.get("reveal") else SCRIPT_MISTAKE}
    if state["runs"] == 0:
        return {"passed": False, "error": "this check never runs the program — call run()"
                if test.get("reveal") else SCRIPT_MISTAKE}
    return {"passed": True, "error": None}


def run_tests(code, tests_json):
    """Run every test. Returns JSON: {"compile_error": str|null, "results": [...]}."""
    tests = json.loads(tests_json)
    try:
        compile(code, FILENAME, "exec")
    except SyntaxError as exc:
        # One message, not the same one per test: nothing ran, so nothing passed.
        return json.dumps({"compile_error": _describe_error(exc), "results": [
            {"name": t["name"], "hidden": t.get("hidden", False), "passed": False}
            for t in tests
        ]})

    results = []
    for test in tests:
        if test["kind"] == "function":
            result = _run_function(code, test)
        elif test["kind"] == "script":
            result = _run_script(code, test)
        else:
            result = _run_io(code, test)
        result["name"] = test["name"]
        result["hidden"] = test.get("hidden", False)
        if result["hidden"]:
            # A hidden test says whether it passed and nothing else — not even the error,
            # which can quote the expected value back.
            result = {"name": result["name"], "hidden": True, "passed": result["passed"]}
        results.append(result)
    return json.dumps({"compile_error": None, "results": results})


# What a stored example may hold (`app/problem_bank.py` refuses more).
MAX_EXAMPLE_PIECES = 400
MAX_EXAMPLE_PIECE_CHARS = 10_000


class NeedsMoreInput(Exception):
    """An example's program asked for more input than the example gives it."""


class _Transcript(io.TextIOBase):
    """stdout for an example: what is printed, interleaved with what is typed in."""

    def __init__(self):
        self.pieces = []

    def add(self, kind, text):
        if not text:
            return
        if self.pieces and self.pieces[-1]["kind"] == kind == "out":
            joined = self.pieces[-1]["text"] + text
            self.pieces[-1]["text"] = joined[:MAX_EXAMPLE_PIECE_CHARS]
        elif len(self.pieces) < MAX_EXAMPLE_PIECES:
            self.pieces.append({"kind": kind, "text": text[:MAX_EXAMPLE_PIECE_CHARS]})

    def write(self, text):
        self.add("out", text)
        return len(text)


def run_example(code, inputs_json):
    """Run the program once as a child would, typing `inputs` in order (17 Oct 2026).

    Returns JSON: {"transcript": [{"kind": "out"|"in", "text"}], "error": str|null}. Unlike
    a test, `input()`'s prompt is part of the output: the point is to show the
    conversation — "Name? ", then "Ken", then "Hi Ken". Fresh globals and the same time
    limit as a test. Running out of inputs stops the run, and says so.
    """
    inputs = list(json.loads(inputs_json))
    transcript = _Transcript()
    namespace = {"__name__": "__main__", "__builtins__": builtins}

    def fake_input(prompt=""):
        transcript.add("out", str(prompt))
        if not inputs:
            raise NeedsMoreInput
        value = inputs.pop(0)
        transcript.add("in", value)
        return value

    namespace["input"] = fake_input
    error = None
    try:
        compiled = compile(code, FILENAME, "exec")
    except SyntaxError as exc:
        return json.dumps({"transcript": [], "error": _describe_error(exc)})
    sys.settrace(_deadline_tracer(time.monotonic() + TIME_LIMIT_SECONDS))
    try:
        with contextlib.redirect_stdout(transcript):
            exec(compiled, namespace)
    except TookTooLong:
        error = "took too long — is there a loop that never ends?"
    except NeedsMoreInput:
        error = "the program asked for more input than this example gives it"
    except SystemExit:
        pass
    except KeyboardInterrupt:
        raise
    except Exception as exc:  # noqa: BLE001 — reported to the teacher
        error = _describe_error(exc)
    finally:
        sys.settrace(None)
    return json.dumps({"transcript": transcript.pieces, "error": error})
