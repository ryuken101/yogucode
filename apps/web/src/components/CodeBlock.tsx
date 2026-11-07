/**
 * Python shown to read, in a question (Ken, 7 Nov 2026): the editor's colours, with line
 * numbers so a teacher can say "look at line 3". Long lines scroll sideways rather than wrap,
 * because a wrapped line of Python reads as two.
 *
 * Plain spans from `lib/pythonTokens.ts` rather than Monaco, which pages without an editor
 * must not have to load, and nothing here is ever parsed as HTML.
 */

import { Fragment } from 'react'
import type { CSSProperties } from 'react'
import { SYNTAX } from '../editor/theme'
import { tokenLines, type TokenKind } from '../lib/pythonTokens'

const KEYWORD: CSSProperties = { color: SYNTAX.strawberry, fontWeight: 700 }

const STYLES: Record<TokenKind, CSSProperties> = {
  plain: { color: SYNTAX.text },
  comment: { color: SYNTAX.dusk, fontStyle: 'italic' },
  // As the editor really shows them, so a child sees `print` the same in both: its Python
  // grammar counts `print` and `True` as keywords. Strawberry is syntax here, as there,
  // never a verdict on the code.
  keyword: KEYWORD,
  builtin: KEYWORD,
  constant: KEYWORD,
  string: { color: SYNTAX.lemon },
  number: { color: SYNTAX.lavender },
  operator: { color: SYNTAX.text },
  bracket: { color: SYNTAX.lemon },
}

function Tokens({ lines }: { lines: ReturnType<typeof tokenLines> }) {
  return lines.map((line, index) => (
    <Fragment key={index}>
      {line.map((token, at) => (
        <span key={at} style={STYLES[token.kind]}>
          {token.text}
        </span>
      ))}
      {index < lines.length - 1 ? '\n' : null}
    </Fragment>
  ))
}

/** A glance at the code, on a Live tile: same colours, no numbers, clipped to what's given. */
export function CodeGlance({ source, className = '' }: { source: string; className?: string }) {
  return (
    <pre className={`overflow-hidden bg-night font-mono ${className}`}>
      <code>
        <Tokens lines={tokenLines(source)} />
      </code>
    </pre>
  )
}

export function CodeBlock({ source, className = 'my-3' }: { source: string; className?: string }) {
  const lines = tokenLines(source.replace(/\n+$/, ''))
  return (
    <div className={`${className} flex overflow-hidden rounded-lg bg-night font-mono text-sm leading-6`}>
      {/* Out of the selection, so copying the code doesn't bring the numbers. */}
      <div
        aria-hidden="true"
        data-testid="line-numbers"
        className="shrink-0 select-none py-3 pl-3 pr-3 text-right"
        style={{ color: SYNTAX.dusk }}
      >
        {lines.map((_, index) => (
          <div key={index}>{index + 1}</div>
        ))}
      </div>
      <pre className="min-w-0 flex-1 overflow-x-auto py-3 pr-4">
        {/* One run of text with real line breaks, so copying it gives back the same code. */}
        <code className="block w-max min-w-full whitespace-pre">
          <Tokens lines={lines} />
        </code>
      </pre>
    </div>
  )
}
