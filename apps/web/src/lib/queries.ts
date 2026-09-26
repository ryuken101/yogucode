/**
 * Server state, through TanStack Query.
 *
 * The key scheme mirrors the API's own resources, so invalidation reads as the sentence
 * it is: renaming a student invalidates that class's roster, rotating a code invalidates
 * that class. Anything that fans out wider than that is a sign the key is wrong.
 *
 * Retries are off for 4xx. A 401, a 404 or a 409 will not become a different answer by
 * being asked again, and retrying them just delays the message a teacher is waiting for.
 */

import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query'
import { api, type Schemas } from './api'
import { ApiError } from './errors'

export const keys = {
  me: ['me'] as const,
  classes: ['classes'] as const,
  class: (classId: string) => ['class', classId] as const,
  roster: (classId: string) => ['roster', classId] as const,
  studentMe: ['student-me'] as const,
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          // Only retry things that might genuinely be transient: a network failure
          // (status 0) or a server fault. Never a 4xx.
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false
          return failureCount < 2
        },
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  })
}

/* --- teacher ---------------------------------------------------------------------- */

export function useMe(options?: Partial<UseQueryOptions<Schemas['TeacherProfileOut'], Error>>) {
  return useQuery({ queryKey: keys.me, queryFn: api.me, ...options })
}

export function useClasses() {
  return useQuery({ queryKey: keys.classes, queryFn: api.listClasses })
}

export function useClass(classId: string) {
  return useQuery({ queryKey: keys.class(classId), queryFn: () => api.readClass(classId) })
}

export function useRoster(classId: string) {
  return useQuery({ queryKey: keys.roster(classId), queryFn: () => api.readRoster(classId) })
}

export function useCreateClass() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: Schemas['ClassIn']) => api.createClass(body),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.classes }),
  })
}

export function useRotateJoinCode(classId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api.rotateJoinCode(classId),
    onSuccess: (updated) => client.setQueryData(keys.class(classId), updated),
  })
}

export function useCommitPaste(classId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (entries: Schemas['BulkEntryIn'][]) => api.commitPaste(classId, entries),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.roster(classId) }),
  })
}

export function useIssuePins(classId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (resetExisting: boolean) => api.issuePins(classId, resetExisting),
    // Issuing a PIN changes `has_pin` on the join picker, not the roster shape — but the
    // roster is where the teacher sees who still needs one.
    onSuccess: () => client.invalidateQueries({ queryKey: keys.roster(classId) }),
  })
}

export function useResetPin(classId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (studentId: string) => api.resetPin(studentId),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.roster(classId) }),
  })
}

export function useRevokeSessions() {
  return useMutation({ mutationFn: (studentId: string) => api.revokeSessions(studentId) })
}

export function useRenameStudent(classId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ studentId, name }: { studentId: string; name: string }) =>
      api.renameStudent(studentId, name),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.roster(classId) }),
  })
}
