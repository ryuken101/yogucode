/**
 * Folder-tree rules the file views share — the editor's explorer (`FileExplorer`) and the
 * Files app (`desktop/Finder.tsx`) — so "where may this go" has one answer.
 */

import type { Schemas } from './api'

type Folder = Schemas['FolderOut']
type File = Schemas['DocumentSummaryOut']

export type TreeItem = { kind: 'file' | 'folder'; id: string }

/** The folder and everything inside it — where a folder may not be moved to. */
export function subtree(folders: Folder[], root: string): Set<string> {
  const found = new Set([root])
  let grew = true
  while (grew) {
    grew = false
    for (const f of folders) {
      if (f.parent_id && found.has(f.parent_id) && !found.has(f.id)) {
        found.add(f.id)
        grew = true
      }
    }
  }
  return found
}

/** "week 1 / loops" — a folder's path, for a Move to… list. */
export function pathOf(folders: Folder[], id: string): string {
  const parts: string[] = []
  let at: string | null = id
  for (let depth = 0; at && depth < 20; depth++) {
    const folder = folders.find((f) => f.id === at)
    if (!folder) break
    parts.unshift(folder.name)
    at = folder.parent_id ?? null
  }
  return parts.join(' / ')
}

/**
 * Whether moving `item` into `folderId` (null: the top) would do anything allowed: not
 * where it already is, and never a folder into itself or anything inside it.
 */
export function canMove(
  item: TreeItem,
  folderId: string | null,
  files: File[],
  folders: Folder[],
): boolean {
  if (item.kind === 'file') {
    const file = files.find((f) => f.id === item.id)
    return Boolean(file) && (file!.folder_id ?? null) !== folderId
  }
  const folder = folders.find((f) => f.id === item.id)
  if (!folder || (folder.parent_id ?? null) === folderId) return false
  return !(folderId && subtree(folders, item.id).has(folderId))
}

/**
 * A name not taken among `taken` (compared ignoring case, as the server does):
 * "stars copy.py", then "stars copy 2.py". The extension stays at the end.
 */
export function copyName(name: string, taken: Iterable<string>, suffix = ' copy'): string {
  const used = new Set([...taken].map((t) => t.toLowerCase()))
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 1; ; n += 1) {
    const candidate = `${stem}${suffix}${n === 1 ? '' : ` ${n}`}${ext}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

/** A name not taken, keeping the original when it is free: for pasting a copy elsewhere. */
export function freeName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((t) => t.toLowerCase()))
  return used.has(name.toLowerCase()) ? copyName(name, used) : name
}
