/**
 * Types for monaco-editor's deep entry points.
 *
 * Only the package root declares types, but importing the root pulls in
 * `editor.main` — every language Monaco ships, and with them a TypeScript, CSS, HTML and
 * JSON language worker. That is roughly 9 MB of build output to teach Python.
 *
 * So the editor imports `editor.api` plus the one grammar it needs, and the missing
 * declarations are supplied here. The paths look odd because the package's `exports` map
 * rewrites `./*` to `./esm/vs/*`.
 */

declare module 'monaco-editor/editor/editor.api' {
  export * from 'monaco-editor'
}

/**
 * The Python grammar, registered as a side effect. `register.d.ts` exists in the package
 * but is not reachable through the exports map, so it is declared here.
 */
declare module 'monaco-editor/languages/definitions/python/register'
