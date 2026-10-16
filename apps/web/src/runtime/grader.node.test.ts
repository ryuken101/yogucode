// @vitest-environment node
/// <reference types="node" />
/**
 * The grader, in the real runtime.
 *
 * Unlike `channel.node.test.ts`, Pyodide is *present* here: the grader is Python that only
 * ever runs inside Pyodide, and its behaviour — what `redirect_stdout` captures, whether a
 * trace function fires inside `while True: pass` — is exactly what a mock would assume
 * instead of check. Pyodide loads in Node in about a second, once for the file.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadPyodide, type PyodideInterface } from 'pyodide'
import { beforeAll, expect, test } from 'vitest'
import type { ExampleRun, TestCheck, TestRun } from './protocol'

let grader: {
  run_tests(code: string, tests: string): string
  run_example(code: string, inputs: string): string
}

beforeAll(async () => {
  const pyodide: PyodideInterface = await loadPyodide()
  const source = readFileSync(fileURLToPath(new URL('./grader.py', import.meta.url)), 'utf8')
  pyodide.FS.writeFile('/home/pyodide/_grader.py', source)
  pyodide.runPython('import sys; sys.path.insert(0, "/home/pyodide")')
  grader = pyodide.pyimport('_grader')
}, 60_000)

function check(code: string, tests: TestCheck[]): TestRun {
  return JSON.parse(grader.run_tests(code, JSON.stringify(tests))) as TestRun
}

const io = (expected: string, extra: Partial<TestCheck> = {}): TestCheck =>
  ({ kind: 'io', name: 'it prints', expected, ...extra }) as TestCheck

test('an io test compares what the program prints', () => {
  const run = check('print(2 + 3)', [io('5'), io('6')])
  expect(run.results.map((r) => r.passed)).toEqual([true, false])
  expect(run.results[1]).toMatchObject({ got: '5', expected: '6' })
})

test('trailing spaces and blank lines do not fail a child', () => {
  const run = check('print("a  ")\nprint()\n', [io('a')])
  expect(run.results[0].passed).toBe(true)
})

test('input() reads the test stdin and its prompt is not part of the output', () => {
  const code = 'name = input("What is your name? ")\nprint("Hi " + name)\n'
  const run = check(code, [io('Hi Aria', { stdin: 'Aria\n' })])
  expect(run.results[0]).toMatchObject({ passed: true, got: 'Hi Aria' })
})

test('running out of stdin is reported, not hung on', () => {
  const run = check('a = input()\nb = input()\n', [io('', { stdin: 'only one\n' })])
  expect(run.results[0].passed).toBe(false)
  expect(run.results[0].error).toMatch(/^EOFError on line 2/)
})

test('contains passes when the expected text appears anywhere', () => {
  const run = check('print("The answer is 42.")', [io('42', { match: 'contains' })])
  expect(run.results[0].passed).toBe(true)
})

test('each test starts from fresh globals', () => {
  // If globals leaked, the second run would see count == 1 and print 2.
  const code = 'try:\n    count += 1\nexcept NameError:\n    count = 1\nprint(count)\n'
  const run = check(code, [io('1'), io('1')])
  expect(run.results.every((r) => r.passed)).toBe(true)
})

test('an error names the line in the child’s code', () => {
  const run = check('x = 1\nprint(y)\n', [io('1')])
  expect(run.results[0].error).toBe("NameError on line 2: name 'y' is not defined")
})

test('printing the right answer then crashing is not a pass', () => {
  const run = check('print(5)\n1 / 0\n', [io('5')])
  expect(run.results[0].passed).toBe(false)
  expect(run.results[0].error).toMatch(/^ZeroDivisionError on line 2/)
})

test('a syntax error is reported once and fails every test', () => {
  const run = check('print("hi"\n', [io('hi'), io('hi')])
  expect(run.compile_error).toMatch(/^SyntaxError on line 1/)
  expect(run.results.map((r) => r.passed)).toEqual([false, false])
})

test('an endless loop fails its own test and the next test still runs', () => {
  const code = 'n = int(input())\nwhile n > 0:\n    pass\nprint("done")\n'
  const run = check(code, [io('done', { stdin: '1\n' }), io('done', { stdin: '0\n' })])
  expect(run.results[0]).toMatchObject({ passed: false })
  expect(run.results[0].error).toMatch(/took too long/)
  expect(run.results[1].passed).toBe(true)
}, 10_000)

test('exit() ends a program normally', () => {
  const run = check('print("bye")\nexit()\nprint("never")\n', [io('bye')])
  expect(run.results[0].passed).toBe(true)
})

test('a function test compares the returned value with ==', () => {
  const code = 'def add(a, b):\n    return a + b\n'
  const run = check(code, [
    { kind: 'function', name: 'adds', call: 'add(2, 3)', expected: '5' },
    { kind: 'function', name: 'lists', call: 'add([1], [2])', expected: '[1, 2]' },
    { kind: 'function', name: 'wrong', call: 'add(2, 2)', expected: '5' },
  ])
  expect(run.results.map((r) => r.passed)).toEqual([true, true, false])
  expect(run.results[2]).toMatchObject({ got: '4', expected: '5' })
})

test('a function test does not feed input() to the program', () => {
  const code = 'x = input()\ndef f():\n    return 1\n'
  const run = check(code, [{ kind: 'function', name: 'f', call: 'f()', expected: '1' }])
  expect(run.results[0].error).toMatch(/asked for input/)
})

test('a missing function is the child’s NameError, not a crash', () => {
  const run = check('print(1)', [{ kind: 'function', name: 'f', call: 'f()', expected: '1' }])
  expect(run.results[0].error).toMatch(/^NameError/)
})

test('a teacher’s invalid expected value fails that test with a clear message', () => {
  const run = check('def f():\n    return 1\n', [
    { kind: 'function', name: 'f', call: 'f()', expected: '1 +' },
  ])
  expect(run.results[0].error).toMatch(/expected value is not valid Python/)
})

test('a hidden test says whether it passed and nothing else', () => {
  const run = check('print(4)', [io('5', { hidden: true })])
  expect(run.results[0]).toEqual({ name: 'it prints', hidden: true, passed: false })
})

/* --- examples: a sample run, as a child would see it ----------------------------------- */

function example(code: string, inputs: string[]): ExampleRun {
  return JSON.parse(grader.run_example(code, JSON.stringify(inputs))) as ExampleRun
}

test('an example interleaves the prompts, what was typed, and what was printed', () => {
  const run = example('name = input("Name? ")\nage = input("Age? ")\nprint("Hi", name, age)\n', [
    'Ken',
    '9',
  ])
  expect(run).toEqual({
    error: null,
    transcript: [
      { kind: 'out', text: 'Name? ' },
      { kind: 'in', text: 'Ken' },
      { kind: 'out', text: 'Age? ' },
      { kind: 'in', text: '9' },
      { kind: 'out', text: 'Hi Ken 9\n' },
    ],
  })
})

test('an example that runs out of inputs stops and says so', () => {
  const run = example('a = input("A? ")\nb = input("B? ")\nprint(a + b)\n', ['1'])
  expect(run.transcript.map((piece) => piece.text)).toEqual(['A? ', '1', 'B? '])
  expect(run.error).toMatch(/more input/)
})

test('an example of a program that does not parse has nothing to show', () => {
  const run = example('print(', [])
  expect(run.transcript).toEqual([])
  expect(run.error).toMatch(/^SyntaxError/)
})
