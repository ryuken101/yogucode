/** Putting a block of Python into a markdown prompt. The prompt stays plain markdown. */

/** A fence longer than any run of backticks in the code, so it can't close itself early. */
function fenceFor(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/** `value` with `code` as a block in place of what's between `start` and `end`. */
export function insertCodeBlock(value: string, start: number, end: number, code: string): string {
  const fence = fenceFor(code)
  const block = `${fence}python\n${code.replace(/\n+$/, '')}\n${fence}`
  const before = value.slice(0, start)
  const after = value.slice(end)
  const gap = (text: string) => (text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n')
  const gapAfter = after === '' || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'
  return `${before}${gap(before)}${block}${gapAfter}${after}`
}
