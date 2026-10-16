/**
 * What a child reads about a problem: its title and prompt, the parts as tabs, the active
 * part's prompt, and how the program should run (17 Oct 2026).
 *
 * Shared by the child's attempt page and the teacher's "Preview as student", so what a
 * teacher previews is what a child sees.
 */

import type { ReactNode } from 'react'
import { Dots } from '../components/Dots'
import { ExampleRun } from '../components/ExampleRun'
import { Markdown } from '../components/Markdown'
import type { ExamplePiece } from '../runtime/protocol'

export interface BriefPart {
  key: string
  label: string | null
  prompt_md: string
  examples: ExamplePiece[][]
}

interface Props {
  title: string
  difficulty: number
  prompt_md: string
  /** Examples of the whole program, above the parts. */
  examples: ExamplePiece[][]
  parts: BriefPart[]
  active: number
  onSelect: (index: number) => void
  /** Above the title — the way back, on the attempt page. */
  top?: ReactNode
}

export function ProblemBrief({ title, difficulty, prompt_md, examples, parts, active, onSelect, top }: Props) {
  const part = parts[active]
  return (
    <>
      <div className="flex flex-col gap-3">
        {top}
        <div className="flex items-center gap-3">
          <Dots value={difficulty} />
          <h1 className="font-display font-semibold text-xl text-grape">{title}</h1>
        </div>
        <Markdown>{prompt_md}</Markdown>
        <ExampleRun examples={examples} />
      </div>

      {parts.length > 1 ? (
        <div role="tablist" aria-label="Parts" className="flex gap-1">
          {parts.map((each, index) => (
            <button
              key={each.key}
              role="tab"
              aria-selected={index === active}
              onClick={() => onSelect(index)}
              className={`rounded-lg px-3 py-1.5 text-sm ring-1 ${
                index === active ? 'bg-grape-pale ring-grape' : 'bg-surface ring-grape/20'
              }`}
            >
              Part ({each.label})
            </button>
          ))}
        </div>
      ) : null}
      {part?.prompt_md ? <Markdown>{part.prompt_md}</Markdown> : null}
      {part ? <ExampleRun key={part.key} examples={part.examples} /> : null}
    </>
  )
}
