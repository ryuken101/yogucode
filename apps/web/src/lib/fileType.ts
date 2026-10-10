/**
 * A file's type is its name, as in VS Code (Ken's decision, 11 Oct 2026): a name ending
 * in `.py` (any case) is a Python file — coloured as Python and runnable; anything else is
 * plain text, shown without colours and not runnable. New files start as `untitled.py`.
 *
 * Nothing is refused: a child can call a file anything. They just see straight away that
 * it won't run until the name ends in `.py`, which is the habit Ken wants them to form.
 */

export function isPythonFile(title: string | null | undefined): boolean {
  return (title ?? '').trim().toLowerCase().endsWith('.py')
}

export type EditorLanguage = 'python' | 'plaintext'

export function languageOf(title: string | null | undefined): EditorLanguage {
  return isPythonFile(title) ? 'python' : 'plaintext'
}
