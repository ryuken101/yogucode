/**
 * The editor's own theme, built from the Yogucode palette.
 *
 * The brand includes a dark theme "for the editor, built on a deep grape ground", and that
 * is this: dark, which is what a code surface should be, but **our** dark — `night` rather
 * than VS Code's blue-grey — with every syntax colour taken from the brand.
 *
 * The palette rule still applies inside the editor: there is no red squiggle and no error
 * colour anywhere. A student's code is never wrong, it is unfinished. Errors appear in the
 * terminal, in lemon ("not yet"), after they press Run. Strawberry on keywords is syntax,
 * like the brackets in the wordmark — never a verdict on the child's code.
 *
 * Every foreground is at least 4.5:1 on `night` (comments, the quietest, are 6.0:1).
 */

import type * as Monaco from 'monaco-editor'

export const THEME_NAME = 'yogucode-night'

/** Kept in sync with `src/theme.css` by hand — Monaco cannot read CSS custom properties. */
const PALETTE = {
  background: '1A1233', // night
  raised: '2B2150', // night-raise
  text: 'FFF6E9', // cream
  lavender: 'B9ACE6',
  // Lavender, dimmed: quieter than code, still 6.0:1. The brand's muted (#7C6BB5) is 3.9:1
  // here — too faint for something a child is meant to read.
  dusk: '9A8CD3',
  grape: '4B2FB8',
  strawberry: 'FF5C8A',
  lemon: 'FFD166',
  mint: '3DBE8B',
} as const

export function defineTheme(monaco: typeof Monaco): void {
  monaco.editor.defineTheme(THEME_NAME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: PALETTE.text },
      { token: 'comment', foreground: PALETTE.dusk, fontStyle: 'italic' },
      { token: 'keyword', foreground: PALETTE.strawberry, fontStyle: 'bold' },
      { token: 'string', foreground: PALETTE.lemon },
      { token: 'string.escape', foreground: PALETTE.lemon, fontStyle: 'bold' },
      { token: 'number', foreground: PALETTE.lavender },
      { token: 'constant', foreground: PALETTE.lavender },
      { token: 'operator', foreground: PALETTE.lavender },
      { token: 'delimiter', foreground: PALETTE.lavender },
      { token: 'identifier', foreground: PALETTE.text },
      // `print`, `input`, `range` — the names a Year 4-6 lesson is mostly about.
      { token: 'support.function', foreground: PALETTE.mint },
    ],
    colors: {
      'editor.background': `#${PALETTE.background}`,
      'editor.foreground': `#${PALETTE.text}`,
      'editorLineNumber.foreground': `#${PALETTE.dusk}`,
      'editorLineNumber.activeForeground': `#${PALETTE.lemon}`,
      'editor.lineHighlightBackground': `#${PALETTE.raised}`,
      'editor.selectionBackground': `#${PALETTE.grape}aa`,
      'editor.inactiveSelectionBackground': `#${PALETTE.raised}`,
      'editorCursor.foreground': `#${PALETTE.lemon}`,
      'editorIndentGuide.background1': `#${PALETTE.raised}`,
      // Indentation is meaningful in Python, so the *active* guide is worth seeing.
      'editorIndentGuide.activeBackground1': `#${PALETTE.dusk}`,
      'editorWhitespace.foreground': `#${PALETTE.dusk}`,
      'editorWidget.background': `#${PALETTE.raised}`,
      'editorWidget.border': `#${PALETTE.grape}`,
      'editorSuggestWidget.background': `#${PALETTE.raised}`,
      'editorSuggestWidget.selectedBackground': `#${PALETTE.grape}aa`,
      'scrollbarSlider.background': `#${PALETTE.raised}`,
      'scrollbarSlider.hoverBackground': `#${PALETTE.grape}`,
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
