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
