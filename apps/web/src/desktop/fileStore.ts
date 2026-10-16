/**
 * What the Files app can do in a place (Ken's decision, 17 Oct 2026): the same actions on
 * a child's own files, a teacher's My code, and a teacher organising a child's files.
 *
 * Each place is a different set of routes (`/me/...`, `/teacher/...`, `/students/{id}/...`),
 * but Finder should not care which: it asks the store, and the store refreshes the lists
 * the change touched. Content travels only to make a copy — a teacher never edits a
 * child's file here (`routers/student_files.py`).
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { api, type Schemas } from '../lib/api'
import { keys } from '../lib/queries'

export type Place = { kind: 'me' } | { kind: 'teacher' } | { kind: 'child'; studentId: string }

export function placeKey(place: Place): string {
  return place.kind === 'child' ? `child:${place.studentId}` : place.kind
}

export interface FileStore {
  createFolder: (name: string, parentId: string | null) => Promise<Schemas['FolderOut']>
  createFile: (
    folderId: string | null,
    title?: string | null,
    content?: string | null,
  ) => Promise<Schemas['DocumentOut']>
  renameFile: (id: string, title: string) => Promise<unknown>
  renameFolder: (id: string, name: string) => Promise<unknown>
  moveFile: (id: string, folderId: string | null) => Promise<unknown>
  moveFolder: (id: string, parentId: string | null) => Promise<unknown>
  deleteFile: (id: string) => Promise<unknown>
  deleteFolder: (id: string) => Promise<unknown>
  readContent: (id: string) => Promise<string>
}

export function useFileStore(place: Place): FileStore {
  const client = useQueryClient()
  const key = placeKey(place)
  // `place` is described completely by its key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => storeFor(client, place), [client, key])
}

/** The store itself, for when the place is not known at render — pasting from another. */
export function storeFor(client: QueryClient, place: Place): FileStore {
  const lists =
    place.kind === 'child'
      ? [keys.childFolders(place.studentId), keys.childDocuments(place.studentId)]
      : place.kind === 'me'
        ? [keys.folders('me'), keys.documents]
        : [keys.folders('teacher'), keys.teacherDocuments]
  const refresh = () => Promise.all(lists.map((queryKey) => client.invalidateQueries({ queryKey })))
  /** A file's own cache, so an open tab in Code shows the new name at once. */
  const remember = (saved: Schemas['DocumentOut']) => {
    if (place.kind === 'me') client.setQueryData(keys.document(saved.id), saved)
    if (place.kind === 'teacher') client.setQueryData(keys.teacherDocument(saved.id), saved)
    return saved
  }
  const after = <T>(promise: Promise<T>) =>
    promise.then(async (value) => {
      await refresh()
      return value
    })

  if (place.kind === 'child') {
    const id = place.studentId
    return {
      createFolder: (name, parentId) => after(api.createChildFolder(id, { name, parent_id: parentId })),
      createFile: (folderId, title = null, content = null) =>
        after(api.createChildDocument(id, { folder_id: folderId, title, content })),
      renameFile: (doc, title) => after(api.updateChildDocument(id, doc, { title })),
      renameFolder: (folder, name) => after(api.updateChildFolder(id, folder, { name })),
      moveFile: (doc, folderId) => after(api.updateChildDocument(id, doc, { folder_id: folderId })),
      moveFolder: (folder, parentId) => after(api.updateChildFolder(id, folder, { parent_id: parentId })),
      deleteFile: (doc) => after(api.archiveChildDocument(id, doc)),
      deleteFolder: (folder) => after(api.deleteChildFolder(id, folder)),
      readContent: async (doc) => (await api.readChildDocument(id, doc)).content,
    } satisfies FileStore
  }

  const scope = place.kind
  const create = scope === 'me' ? api.createDocument : api.createTeacherDocument
  const save = scope === 'me' ? api.saveDocument : api.saveTeacherDocument
  const archive = scope === 'me' ? api.archiveDocument : api.archiveTeacherDocument
  const read = scope === 'me' ? api.readDocument : api.readTeacherDocument
  return {
    createFolder: (name, parentId) => after(api.createFolder(scope, { name, parent_id: parentId })),
    createFile: (folderId, title = null, content = null) =>
      after(create({ folder_id: folderId, title, content }).then(remember)),
    renameFile: (doc, title) => after(save(doc, { title, content: null }).then(remember)),
    renameFolder: (folder, name) => after(api.updateFolder(scope, folder, { name })),
    moveFile: (doc, folderId) => after(save(doc, { folder_id: folderId }).then(remember)),
    moveFolder: (folder, parentId) => after(api.updateFolder(scope, folder, { parent_id: parentId })),
    deleteFile: (doc) => after(archive(doc)),
    deleteFolder: (folder) => after(api.deleteFolder(scope, folder)),
    readContent: async (doc) => (await read(doc)).content,
  } satisfies FileStore
}
