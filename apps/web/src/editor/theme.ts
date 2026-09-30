/**
 * The editor's own theme, built from the product palette.
 *
 * product-spec §8 is explicit: *"The editor needs its own considered theme in these
 * colours. Don't drop a default dark VS Code theme into a cream page."* So this is dark —
 * which is what a code surface should be, and what was asked for — but it is **our** dark:
 * a deepened `ink` background rather than VS Code's blue-grey, with every syntax colour
 * taken from the eleven in the palette.
 *
 * The one §8 rule that still applies inside the editor: nothing here is rust. A student's
 * code is never wrong, it is unfinished, so there is no red squiggle and no red anything.
 * Errors appear in the terminal, in amber, after they press Run.
 */

import type * as Monaco from 'monaco-editor'

export const THEME_NAME = 'magikid-dark'

/** Kept in sync with `src/theme.css` by hand — Monaco cannot read CSS custom properties. */
const PALETTE = {
  background: '23211E', // ink, deepened
  raised: '302D29',
  text: 'F7F4ED', // cream
  muted: '6B665E', // ink-soft
  sky: '7B96D4',
  skyDeep: '5A77B8',
  skyPale: 'C4D3EE',
  sage: '7D9471',
  amber: 'D9A441',
  terracotta: 'C1633F',
} as const

export function defineTheme(monaco: typeof Monaco): void {
  monaco.editor.defineTheme(THEME_NAME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: PALETTE.text },
      // Terracotta for comments: §8 calls it an accent to use sparingly, and comments are
      // exactly that — present, readable, not competing with the code.
      { token: 'comment', foreground: PALETTE.terracotta, fontStyle: 'italic' },
      { token: 'keyword', foreground: PALETTE.sky, fontStyle: 'bold' },
      { token: 'string', foreground: PALETTE.sage },
      { token: 'string.escape', foreground: PALETTE.sage, fontStyle: 'bold' },
      { token: 'number', foreground: PALETTE.amber },
      { token: 'constant', foreground: PALETTE.amber },
      { token: 'operator', foreground: PALETTE.skyPale },
      { token: 'delimiter', foreground: PALETTE.skyPale },
      { token: 'identifier', foreground: PALETTE.text },
      // `print`, `input`, `range` — the names a Year 4-6 lesson is mostly about.
      { token: 'support.function', foreground: PALETTE.skyPale },
    ],
    colors: {
      'editor.background': `#${PALETTE.background}`,
      'editor.foreground': `#${PALETTE.text}`,
      'editorLineNumber.foreground': PALETTE.muted,
      'editorLineNumber.activeForeground': `#${PALETTE.skyPale}`,
      'editor.lineHighlightBackground': `#${PALETTE.raised}`,
      'editor.selectionBackground': `#${PALETTE.skyDeep}66`,
      'editor.inactiveSelectionBackground': `#${PALETTE.raised}`,
      'editorCursor.foreground': `#${PALETTE.skyPale}`,
      'editorIndentGuide.background1': `#${PALETTE.raised}`,
      // Indentation is meaningful in Python, so the *active* guide is worth seeing.
      'editorIndentGuide.activeBackground1': PALETTE.muted,
      'editorWhitespace.foreground': PALETTE.muted,
      'editorWidget.background': `#${PALETTE.raised}`,
      'editorWidget.border': PALETTE.muted,
      'editorSuggestWidget.background': `#${PALETTE.raised}`,
      'editorSuggestWidget.selectedBackground': `#${PALETTE.skyDeep}66`,
      'scrollbarSlider.background': `#${PALETTE.raised}`,
      'scrollbarSlider.hoverBackground': PALETTE.muted,
    },
  })
}

/**
 * Editor options.
 *
 * `tabSize: 4` and `insertSpaces` because that is PEP 8 and because a child who later
 * opens their file anywhere else should see what they saw here. `detectIndentation` is off
 * so a file that happens to start with two spaces does not silently change the rule
 * mid-lesson.
 */
export const OPTIONS: Monaco.editor.IStandaloneEditorConstructionOptions = {
  language: 'python',
  theme: THEME_NAME,
  fontSize: 15,
  lineHeight: 24,
  // Matches --font-mono in theme.css, so the editor and the terminal agree.
  fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  tabSize: 4,
  insertSpaces: true,
  detectIndentation: false,
  minimap: { enabled: false },
  // A minimap and a horizontal ruler are noise for a twelve-line program.
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  scrollBeyondLastLine: false,
  renderLineHighlight: 'line',
  automaticLayout: true,
  padding: { top: 12, bottom: 12 },
  lineNumbersMinChars: 3,
  wordWrap: 'on',
  // Nothing in a Year 4-6 lesson benefits from a lightbulb offering refactorings.
  lightbulb: { enabled: undefined },
  contextmenu: false,
  // Tab moves indentation, not focus. That was the whole complaint: in a textarea Tab
  // moves to the next control, which makes Python unwritable.
  tabFocusMode: false,
}

/**
 * The completions toggle — product-spec §3.1 calls it "the sharpest feature in the
 * product": on for classwork, **off for quiz mode** in Phase 7, because autocomplete
 * corrupts the retrieval signal.
 *
 * Applied with `updateOptions()` so it flips without rebuilding the editor, which keeps it
 * entirely out of the code that runs Python.
 */
export function completionOptions(
  enabled: boolean,
  // wordBasedSuggestions lives on IGlobalEditorOptions rather than IEditorOptions;
  // updateOptions() accepts both.
): Monaco.editor.IEditorOptions & Monaco.editor.IGlobalEditorOptions {
  return {
    quickSuggestions: enabled,
    suggestOnTriggerCharacters: enabled,
    acceptSuggestionOnEnter: enabled ? 'on' : 'off',
    wordBasedSuggestions: enabled ? 'currentDocument' : 'off',
    tabCompletion: enabled ? 'on' : 'off',
    parameterHints: { enabled },
  }
}
