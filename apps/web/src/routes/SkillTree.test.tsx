/**
 * The skill tree (Ken, 21 Nov 2026): tags nest as deep as a teacher likes, a sub-skill is
 * added under any tag, and a tag can't be moved inside its own branch.
 */

import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { expect, test } from 'vitest'
import type { Schemas } from '../lib/api'
import { renderScreen } from '../test/render'
import { server } from '../test/server'
import { SkillTree } from './SkillTree'

const tag = (over: Partial<Schemas['ConceptOut']> & Pick<Schemas['ConceptOut'], 'id' | 'label'>) =>
  ({ key: over.id, status: 'active', own: true, parent_id: null, sort_order: 10, ...over }) as Schemas['ConceptOut']

const DICTS = tag({ id: 'dicts', label: 'Dictionaries' })
const VALUES = tag({ id: 'values', label: '.values()', parent_id: 'dicts' })
const LOOP = tag({ id: 'loop', label: 'in a loop', parent_id: 'values' })
const LISTS = tag({ id: 'lists', label: 'Lists', sort_order: 20 })

test('the tree nests, and a sub-skill is added under the tag it belongs to', async () => {
  let list = [DICTS, VALUES, LOOP, LISTS]
  const made: Schemas['ConceptIn'][] = []
  server.use(
    http.get('/api/concepts', () => HttpResponse.json(list)),
    http.post('/api/concepts', async ({ request }) => {
      const body = (await request.json()) as Schemas['ConceptIn']
      made.push(body)
      const child = tag({ id: 'append', label: body.label, parent_id: body.parent_id ?? null })
      list = [...list, child]
      return HttpResponse.json(child, { status: 201 })
    }),
  )
  const { user } = renderScreen(<SkillTree />)

  const dicts = await screen.findByRole('treeitem', { name: 'Dictionaries' })
  expect(within(dicts).getByRole('treeitem', { name: 'in a loop' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Lists options' }))
  await user.click(screen.getByRole('menuitem', { name: 'Add a sub-skill' }))
  await user.type(screen.getByLabelText('New sub-skill name'), '.append(){Enter}')

  await waitFor(() => expect(made).toEqual([{ label: '.append()', parent_id: 'lists' }]))
  const lists = await screen.findByRole('treeitem', { name: 'Lists' })
  expect(await within(lists).findByRole('treeitem', { name: '.append()' })).toBeInTheDocument()
})

test('a tag can’t be moved into its own branch, and moves where it is told', async () => {
  const moves: Schemas['ConceptPatch'][] = []
  server.use(
    http.get('/api/concepts', () => HttpResponse.json([DICTS, VALUES, LOOP, LISTS])),
    http.patch('/api/concepts/values', async ({ request }) => {
      const body = (await request.json()) as Schemas['ConceptPatch']
      moves.push(body)
      return HttpResponse.json({ ...VALUES, parent_id: body.parent_id ?? null })
    }),
  )
  const { user } = renderScreen(<SkillTree />)

  await user.click(await screen.findByRole('button', { name: '.values() options' }))
  await user.click(screen.getByRole('menuitem', { name: 'Move to…' }))
  const where = screen.getByLabelText('Put it under')
  const choices = within(where)
    .getAllByRole('option')
    .map((o) => o.textContent)
  expect(choices).toEqual(['The top of the tree', 'Dictionaries', 'Lists'])

  await user.selectOptions(where, 'Lists')
  await user.click(screen.getByRole('button', { name: 'Move' }))
  await waitFor(() => expect(moves).toEqual([{ parent_id: 'lists' }]))
})
