/**
 * Everything a student attempts: difficulty, concepts, starter code, the reference
 * solution, the tests and the hints. Used once for a problem without parts, once per part
 * for a problem with them.
 */

import { CodeSurface } from '../editor/CodeSurface'
import { DotsPicker } from '../components/Dots'
import type { Schemas } from '../lib/api'
import type { TestResult } from '../runtime/protocol'
import { ConceptPicker } from './ConceptPicker'
import type { LeafDoc } from './doc'
import { HintsEditor } from './HintsEditor'
import { TestsEditor } from './TestsEditor'

interface Props {
  /** Remount key for the code editors — Monaco is uncontrolled after mount. */
  editorKey: string
  leaf: LeafDoc
  onChange: (leaf: LeafDoc) => void
  concepts: Schemas['ConceptOut'][]
  results?: TestResult[] | null
  disabled?: boolean
}

function CodeBox({
  label,
  hint,
  value,
  onChange,
  readOnly,
}: {
  label: string
  hint: string
  value: string
  onChange: (value: string) => void
  readOnly?: boolean
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium text-ink">
        {label} <span className="font-normal text-ink-soft">— {hint}</span>
      </p>
      <div className="h-48 overflow-hidden rounded-lg ring-1 ring-ink/20">
        <CodeSurface value={value} onChange={onChange} readOnly={readOnly} autoFocus={false} />
      </div>
    </div>
  )
}

export function LeafEditor({ editorKey, leaf, onChange, concepts, results, disabled }: Props) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start gap-6">
        <div>
          <p className="mb-1.5 text-sm font-medium text-ink">Difficulty</p>
          <DotsPicker
            value={leaf.difficulty}
            disabled={disabled}
            onChange={(difficulty) => onChange({ ...leaf, difficulty })}
          />
        </div>
        <div className="min-w-0 flex-1">
          <ConceptPicker
            concepts={concepts}
            selected={leaf.concept_ids ?? []}
            primary={leaf.primary_concept_id ?? null}
            disabled={disabled}
            onChange={(concept_ids, primary_concept_id) =>
              onChange({ ...leaf, concept_ids, primary_concept_id })
            }
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <CodeBox
          key={`${editorKey}-starter`}
          label="Starter code"
          hint="what the student begins with"
          value={leaf.starter_code}
          readOnly={disabled}
          onChange={(starter_code) => onChange({ ...leaf, starter_code })}
        />
        <CodeBox
          key={`${editorKey}-solution`}
          label="Reference solution"
          hint="never shown to students"
          value={leaf.solution_code}
          readOnly={disabled}
          onChange={(solution_code) => onChange({ ...leaf, solution_code })}
        />
      </div>

      <section>
        <h3 className="mb-2 font-serif text-lg text-ink">Checks</h3>
        <TestsEditor
          tests={leaf.tests ?? []}
          results={results}
          disabled={disabled}
          onChange={(tests) => onChange({ ...leaf, tests })}
        />
      </section>

      <section>
        <h3 className="mb-2 font-serif text-lg text-ink">Hints</h3>
        <HintsEditor
          hints={leaf.hints ?? []}
          disabled={disabled}
          onChange={(hints) => onChange({ ...leaf, hints })}
        />
      </section>
    </div>
  )
}
