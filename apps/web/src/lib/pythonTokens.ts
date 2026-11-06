/**
 * Python, sorted into the kinds of thing the editor colours, for code shown in a question
 * (`components/CodeBlock.tsx`). Enough to read by, not a parser: Monaco is a megabyte, and a
 * child reading a question shouldn't have to wait for one.
 *
 * The rule everything depends on: joining the tokens gives back the source exactly. Whatever
 * this doesn't recognise is plain text, never dropped, so the worst a mistake here can do is
 * colour something oddly.
 */

export type TokenKind =
  | 'plain'
  | 'comment'
  | 'keyword'
  | 'string'
  | 'number'
  | 'constant'
  | 'operator'
  | 'bracket'
  | 'builtin'

export interface Token {
  kind: TokenKind
  text: string
}

const KEYWORDS = new Set(
  'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(
    ' ',
  ),
)
const CONSTANTS = new Set(['True', 'False', 'None'])
// The names a Year 4-6 lesson is mostly about.
const BUILTINS = new Set(
  'abs all any bool chr dict enumerate filter float format input int isinstance len list map max min open ord pow print range reversed round set sorted str sum tuple type zip'.split(
    ' ',
  ),
)

const PATTERN = new RegExp(
  [
    /(?<comment>#[^\n]*)/,
    // Triple quotes first, or `"""` reads as an empty string and a stray quote. Unclosed, it
    // runs to the end, as Python would read it.
    /(?<string>(?:\b[rRbBuUfF]{1,2})?(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?))/,
    /(?<number>\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+)\b)/,
    /(?<word>[A-Za-z_]\w*)/,
    /(?<bracket>[()[\]{}]+)/,
    /(?<operator>[-+*/%=<>!&|^~:;,.@]+)/,
  ]
    .map((part) => part.source)
    .join('|'),
  'g',
)

export function tokenizePython(source: string): Token[] {
  const tokens: Token[] = []
  const push = (kind: TokenKind, text: string) => {
    const last = tokens[tokens.length - 1]
    if (last && last.kind === kind) last.text += text
    else tokens.push({ kind, text })
  }
  let at = 0
  for (const match of source.matchAll(PATTERN)) {
    if (match.index > at) push('plain', source.slice(at, match.index))
    const found = match.groups ?? {}
    if (found.comment !== undefined) push('comment', match[0])
    else if (found.string !== undefined) push('string', match[0])
    else if (found.number !== undefined) push('number', match[0])
    else if (found.bracket !== undefined) push('bracket', match[0])
    else if (found.operator !== undefined) push('operator', match[0])
    else if (KEYWORDS.has(match[0])) push('keyword', match[0])
    else if (CONSTANTS.has(match[0])) push('constant', match[0])
    else if (BUILTINS.has(match[0])) push('builtin', match[0])
    else push('plain', match[0])
    at = match.index + match[0].length
  }
  if (at < source.length) push('plain', source.slice(at))
  return tokens
}

/** The tokens line by line: a string across lines is cut at each line's end. */
export function tokenLines(source: string): Token[][] {
  const lines: Token[][] = [[]]
  for (const token of tokenizePython(source)) {
    token.text.split('\n').forEach((piece, index) => {
      if (index > 0) lines.push([])
      if (piece) lines[lines.length - 1]!.push({ kind: token.kind, text: piece })
    })
  }
  return lines
}
