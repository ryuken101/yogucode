/**
 * A leaf's test cases.
 *
 * Two kinds, in the order a Year 4–6 class meets them: "prints" (give it this input, it
 * should print this) and "returns" (call this function, it should give back this). The
 * row's fields change with its kind; everything else — name, hidden — is shared.
 */

import { Button } from '../components/Button'
import { Select, TextInput, Textarea } from '../components/Field'
import type { TestResult } from '../runtime/protocol'
import { newTest, type TestDoc } from './doc'
import { TestResultLine } from './TestResults'

interface Props {
  tests: TestDoc[]
  onChange: (tests: TestDoc[]) => void
  /** The last run of the reference solution, aligned by index. Absent when stale. */
  results?: TestResult[] | null
  disabled?: boolean
}

export function TestsEditor({ tests, onChange, results, disabled }: Props) {
  function update(index: number, next: TestDoc) {
    onChange(tests.map((test, i) => (i === index ? next : test)))
  }

  return (
    <div className="flex flex-col gap-3">
      {tests.map((test, index) => (
        <div key={index} className="rounded-lg bg-cream/60 p-3 ring-1 ring-line">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
            <TextInput
              label="Name a student will see"
              value={test.name}
              maxLength={120}
              disabled={disabled}
              onChange={(event) => update(index, { ...test, name: event.target.value })}
            />
            <Select
              label="Checks that it…"
              value={test.kind}
              disabled={disabled}
              onChange={(event) => {
                const kind = event.target.value as TestDoc['kind']
                if (kind !== test.kind) update(index, { ...newTest(kind, index), name: test.name })
              }}
            >
              <option value="io">prints</option>
              <option value="function">returns</option>
            </Select>
            <label className="flex items-end gap-2 pb-2 text-sm text-grape">
              <input
                type="checkbox"
                checked={test.hidden}
                disabled={disabled}
                onChange={(event) => update(index, { ...test, hidden: event.target.checked })}
              />
              Hidden
            </label>
          </div>

          {test.kind === 'io' ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Textarea
                label="Typed in (one answer per line)"
                rows={3}
                value={test.stdin}
                disabled={disabled}
                onChange={(event) => update(index, { ...test, stdin: event.target.value })}
              />
              <div className="flex flex-col gap-2">
                <Textarea
                  label="Should print"
                  rows={3}
                  value={test.expected}
                  disabled={disabled}
                  onChange={(event) => update(index, { ...test, expected: event.target.value })}
                />
                <Select
                  label="Match"
                  value={test.match}
                  disabled={disabled}
                  onChange={(event) =>
                    update(index, {
                      ...test,
                      match: event.target.value as 'exact' | 'contains',
                    })
                  }
                >
                  <option value="exact">exactly (ignoring trailing spaces)</option>
                  <option value="contains">somewhere in the output</option>
                </Select>
              </div>
            </div>
          ) : (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <TextInput
                label="Call"
                placeholder="add(2, 3)"
                className="font-mono"
                value={test.call}
                disabled={disabled}
                onChange={(event) => update(index, { ...test, call: event.target.value })}
              />
              <TextInput
                label="Should return"
                placeholder="5"
                value={test.expected}
                disabled={disabled}
                onChange={(event) => update(index, { ...test, expected: event.target.value })}
              />
            </div>
          )}

          <div className="mt-3 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              {results?.[index] ? <TestResultLine result={results[index]} /> : null}
            </div>
            {disabled ? null : (
              <Button
                variant="quiet"
                onClick={() => onChange(tests.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            )}
          </div>
        </div>
      ))}

      {disabled ? null : (
        <div>
          <Button
            variant="secondary"
            onClick={() => onChange([...tests, newTest('io', tests.length)])}
            disabled={tests.length >= 30}
          >
            Add a check
          </Button>
        </div>
      )}
    </div>
  )
}
