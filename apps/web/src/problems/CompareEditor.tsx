/**
 * The form for a "matches my solution" check (Ken's decision, 17 Oct 2026): no code.
 *
 * Three things to say: what to type at each `input()` (every number in a range, a list of
 * values, or some random numbers — rows combine), which values the student chooses in
 * their own program (`ships`) and what those must be, and how strictly to compare. The
 * grader then runs the student's program and the reference solution — with the student's
 * values put into it — on every case.
 */

import { Button } from '../components/Button'
import { Select, TextInput } from '../components/Field'
import { caseCount, type CompareDoc } from './doc'

type Row = NonNullable<CompareDoc['inputs']>[number]
type Chosen = NonNullable<CompareDoc['chosen']>[number]
type Rule = NonNullable<Chosen['rule']>

interface Props {
  test: CompareDoc
  onChange: (test: CompareDoc) => void
  disabled?: boolean
}

function NumberBox({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string
  value: number | null | undefined
  onChange: (value: number) => void
  disabled?: boolean
}) {
  return (
    <TextInput
      label={label}
      type="number"
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
      className="w-24"
    />
  )
}

const NEW_ROW: Record<Row['mode'], Row> = {
  range: { mode: 'range', start: 0, end: 9 },
  values: { mode: 'values', values: ['yes', 'no'] },
  random: { mode: 'random', count: 10, start: 1, end: 100 },
}

const NEW_RULE: Record<Rule['type'], Rule> = {
  none: { type: 'none' },
  number: { type: 'number', min: 0, max: 9 },
  numbers: { type: 'numbers', count: 3, min: 0, max: 9, distinct: true },
  list: { type: 'list', min_length: 1 },
  text: { type: 'text' },
}

export function CompareEditor({ test, onChange, disabled }: Props) {
  const inputs = test.inputs ?? []
  const chosen = test.chosen ?? []
  const cases = caseCount(test)

  const setRow = (index: number, row: Row) =>
    onChange({ ...test, inputs: inputs.map((r, i) => (i === index ? row : r)) })
  const setChosen = (index: number, next: Chosen) =>
    onChange({ ...test, chosen: chosen.map((c, i) => (i === index ? next : c)) })

  return (
    <div className="mt-3 flex flex-col gap-4">
      <p className="text-sm text-muted">
        Runs their program and your reference solution on every case below, with the values
        they chose put into yours, and checks they print the same.
      </p>

      <section aria-label="Inputs to try" className="flex flex-col gap-2">
        <h4 className="text-sm font-medium text-grape">Try these inputs — one row per input(), in order</h4>
        {inputs.length === 0 ? (
          <p className="text-sm text-muted">No inputs: it runs once, with nothing typed.</p>
        ) : null}
        {inputs.map((row, index) => (
          <div key={index} className="flex flex-wrap items-end gap-2">
            <Select
              label={`input() ${index + 1}`}
              value={row.mode}
              disabled={disabled}
              onChange={(event) => setRow(index, NEW_ROW[event.target.value as Row['mode']])}
            >
              <option value="range">every whole number from…</option>
              <option value="values">each of these values</option>
              <option value="random">some random whole numbers</option>
            </Select>
            {row.mode === 'range' ? (
              <>
                <NumberBox label="From" value={row.start} disabled={disabled} onChange={(start) => setRow(index, { ...row, start })} />
                <NumberBox label="To" value={row.end} disabled={disabled} onChange={(end) => setRow(index, { ...row, end })} />
              </>
            ) : row.mode === 'values' ? (
              <TextInput
                label="Values, separated by commas"
                value={(row.values ?? []).join(', ')}
                disabled={disabled}
                onChange={(event) =>
                  setRow(index, {
                    ...row,
                    values: event.target.value.split(',').map((v) => v.trim()).filter(Boolean),
                  })
                }
              />
            ) : (
              <>
                <NumberBox label="How many" value={row.count} disabled={disabled} onChange={(count) => setRow(index, { ...row, count })} />
                <NumberBox label="From" value={row.start} disabled={disabled} onChange={(start) => setRow(index, { ...row, start })} />
                <NumberBox label="To" value={row.end} disabled={disabled} onChange={(end) => setRow(index, { ...row, end })} />
              </>
            )}
            {disabled ? null : (
              <Button variant="quiet" onClick={() => onChange({ ...test, inputs: inputs.filter((_, i) => i !== index) })}>
                Remove
              </Button>
            )}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          {disabled || inputs.length >= 4 ? null : (
            <Button variant="secondary" onClick={() => onChange({ ...test, inputs: [...inputs, NEW_ROW.range] })}>
              Add an input
            </Button>
          )}
          <span className={`text-sm ${cases > 200 ? 'text-not-yet-ink' : 'text-muted'}`}>
            Tries {cases} case{cases === 1 ? '' : 's'}
            {cases > 200 ? ' — at most 200, so use fewer values' : ''}
          </span>
        </div>
      </section>

      <section aria-label="Values the student chooses" className="flex flex-col gap-2">
        <h4 className="text-sm font-medium text-grape">Values the student chooses</h4>
        <p className="text-sm text-muted">
          Their value is used in your solution instead of yours. Your solution must set it at
          the top of the file, e.g. <code className="font-mono text-grape">ships = [2, 5, 7]</code>.
        </p>
        {chosen.map((value, index) => {
          const rule = value.rule ?? NEW_RULE.none
          return (
            <div key={index} className="flex flex-wrap items-end gap-2">
              <TextInput
                label="Variable"
                value={value.name}
                disabled={disabled}
                className="w-32 font-mono"
                onChange={(event) => setChosen(index, { ...value, name: event.target.value.trim() })}
              />
              <Select
                label="It must be"
                value={rule.type}
                disabled={disabled}
                onChange={(event) => setChosen(index, { ...value, rule: NEW_RULE[event.target.value as Rule['type']] })}
              >
                <option value="none">anything</option>
                <option value="number">a whole number from…</option>
                <option value="numbers">a list of whole numbers</option>
                <option value="list">a list with at least…</option>
                <option value="text">some text</option>
              </Select>
              {rule.type === 'number' ? (
                <>
                  <NumberBox label="From" value={rule.min} disabled={disabled} onChange={(min) => setChosen(index, { ...value, rule: { ...rule, min } })} />
                  <NumberBox label="To" value={rule.max} disabled={disabled} onChange={(max) => setChosen(index, { ...value, rule: { ...rule, max } })} />
                </>
              ) : rule.type === 'numbers' ? (
                <>
                  <NumberBox
                    label="How many (blank: any)"
                    value={rule.count}
                    disabled={disabled}
                    onChange={(count) => setChosen(index, { ...value, rule: { ...rule, count: Number.isNaN(count) || count === 0 ? null : count } })}
                  />
                  <NumberBox label="From" value={rule.min} disabled={disabled} onChange={(min) => setChosen(index, { ...value, rule: { ...rule, min } })} />
                  <NumberBox label="To" value={rule.max} disabled={disabled} onChange={(max) => setChosen(index, { ...value, rule: { ...rule, max } })} />
                  <label className="flex items-center gap-2 pb-2 text-sm text-grape">
                    <input
                      type="checkbox"
                      checked={rule.distinct}
                      disabled={disabled}
                      onChange={(event) => setChosen(index, { ...value, rule: { ...rule, distinct: event.target.checked } })}
                    />
                    all different
                  </label>
                </>
              ) : rule.type === 'list' ? (
                <NumberBox
                  label="Items"
                  value={rule.min_length}
                  disabled={disabled}
                  onChange={(min_length) => setChosen(index, { ...value, rule: { ...rule, min_length } })}
                />
              ) : null}
              {disabled ? null : (
                <Button variant="quiet" onClick={() => onChange({ ...test, chosen: chosen.filter((_, i) => i !== index) })}>
                  Remove
                </Button>
              )}
            </div>
          )
        })}
        {disabled || chosen.length >= 4 ? null : (
          <div>
            <Button
              variant="secondary"
              onClick={() => onChange({ ...test, chosen: [...chosen, { name: '', rule: NEW_RULE.none }] })}
            >
              Add a value they choose
            </Button>
          </div>
        )}
      </section>

      <Select
        label="Compare"
        value={test.match}
        disabled={disabled}
        onChange={(event) => onChange({ ...test, match: event.target.value as CompareDoc['match'] })}
      >
        <option value="exact">exactly (ignoring trailing spaces)</option>
        <option value="contains">their output contains mine</option>
      </Select>
    </div>
  )
}
