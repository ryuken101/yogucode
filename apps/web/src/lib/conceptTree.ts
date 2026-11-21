/**
 * The centre's concept tags as a tree (Ken, 21 Nov 2026): the API sends them flat, each
 * naming its parent. Shared by the tag picker and the Skills app's tree editor.
 */

import type { Schemas } from './api'

export type Concept = Schemas['ConceptOut']

export interface ConceptNode {
  concept: Concept
  depth: number
  children: ConceptNode[]
}

const byOrder = (a: Concept, b: Concept) => a.sort_order - b.sort_order || a.label.localeCompare(b.label)

/** The forest, siblings in order. A tag whose parent isn't in the list sits at the top. */
export function buildTree(concepts: Concept[]): ConceptNode[] {
  const ids = new Set(concepts.map((c) => c.id))
  const children = new Map<string | null, Concept[]>()
  for (const concept of concepts) {
    const parent = concept.parent_id && ids.has(concept.parent_id) ? concept.parent_id : null
    children.set(parent, [...(children.get(parent) ?? []), concept])
  }
  const seen = new Set<string>()
  const grow = (parent: string | null, depth: number): ConceptNode[] =>
    [...(children.get(parent) ?? [])].sort(byOrder).flatMap((concept) => {
      if (seen.has(concept.id)) return [] // a cycle in bad data: show each tag once
      seen.add(concept.id)
      return [{ concept, depth, children: grow(concept.id, depth + 1) }]
    })
  return grow(null, 0)
}

/** Every node, parents before their children: the order a tree list is read in. */
export function flatten(nodes: ConceptNode[]): ConceptNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)])
}

/** A tag and everything under it. Moving a tag into any of these would make a loop. */
export function branchIds(concepts: Concept[], rootId: string): Set<string> {
  const found = new Set([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const concept of concepts) {
      if (concept.parent_id && found.has(concept.parent_id) && !found.has(concept.id)) {
        found.add(concept.id)
        grew = true
      }
    }
  }
  return found
}

/** "Dictionaries › .values()", for a tag shown away from its place in the tree. */
export function pathLabel(concepts: Concept[], id: string): string {
  const byId = new Map(concepts.map((c) => [c.id, c]))
  const names: string[] = []
  let current = byId.get(id)
  while (current && !names.includes(current.label)) {
    names.unshift(current.label)
    current = current.parent_id ? byId.get(current.parent_id) : undefined
  }
  return names.join(' › ')
}

/**
 * After the first edit the built-ins come back with new ids (the centre's own copies, same
 * keys). A screen still holding the old ids maps them across by key.
 */
export function remapByKey(ids: string[], before: Concept[], after: Concept[]): string[] {
  const live = new Set(after.map((c) => c.id))
  const keyOf = new Map(before.map((c) => [c.id, c.key]))
  const idOf = new Map(after.map((c) => [c.key, c.id]))
  return ids.map((id) => (live.has(id) ? id : (idOf.get(keyOf.get(id) ?? '') ?? id)))
}

/** What a delete takes with it, in words, for the confirmation. */
export function impactNote(impact: Schemas['ConceptImpactOut'] | null): string | undefined {
  if (!impact) return undefined
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
  const parts: string[] = []
  if (impact.subskills === 1) parts.push('its sub-skill goes with it')
  else if (impact.subskills) parts.push(`its ${impact.subskills} sub-skills go with it`)
  const users = [
    impact.problems ? n(impact.problems, 'problem') : null,
    impact.lessons ? n(impact.lessons, 'lesson') : null,
  ].filter(Boolean)
  if (users.length) parts.push(`${users.join(' and ')} will lose the tag until it’s restored`)
  if (!parts.length) return 'Nothing uses it yet.'
  const said = parts.join('; ')
  return `${said[0].toUpperCase()}${said.slice(1)}. Children’s work and marks are kept.`
}
