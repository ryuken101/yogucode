/**
 * The centre's tags (Ken, 14 and 21 Nov 2026): a teacher adds one from the picker and it
 * goes on the problem; every tag has a menu, sub-skills included; a refusal is "not yet",
 * never red; a delete says what goes with it.
 */

import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { expect, test } from 'vitest'
import type { Schemas } from '../lib/api'
import { useConcepts } from '../lib/queries'
import { renderScreen } from '../test/render'
import { server } from '../test/server'
import { ConceptPicker } from './ConceptPicker'

const tag = (over: Partial<Schemas['ConceptOut']> & Pick<Schemas['ConceptOut'], 'id' | 'key' | 'label'>) =>
  ({ status: 'active', own: true, parent_id: null, sort_order: 10, ...over }) as Schemas['ConceptOut']
const LISTS = tag({ id: 'c1', key: 'lists', label: 'Lists', status: 'provisional', own: false })
const TURTLE = tag({ id: 'c2', key: 'turtle', label: 'Turtle', sort_order: 20 })

function Harness({ onPick }: { onPick?: (selected: string[], primary: string | null) => void }) {
  const concepts = useConcepts()
  const [selected, setSelected] = useState<string[]>([])
  const [primary, setPrimary] = useState<string | null>(null)
  return (
    <ConceptPicker
      concepts={concepts.data ?? []}
      selected={selected}
      primary={primary}
      onChange={(next, main) => {
        setSelected(next)
        setPrimary(main)
        onPick?.(next, main)
      }}
    />
  )
}

test('a new tag is made and put on the problem as its main concept', async () => {
  let list = [LISTS]
  const made: string[] = []
  server.use(
    http.get('/api/concepts', () => HttpResponse.json(list)),
    http.post('/api/concepts', async ({ request }) => {
      const { label } = (await request.json()) as Schemas['ConceptIn']
      made.push(label)
      const made_ = tag({ id: 'c9', key: 'turtle_drawing', label, sort_order: 30 })
      list = [...list, made_]
      return HttpResponse.json(made_, { status: 201 })
    }),
  )
  const picks: [string[], string | null][] = []
  const { user } = renderScreen(<Harness onPick={(s, p) => picks.push([s, p])} />)

  await screen.findByRole('button', { name: 'Lists' })
  // A built-in tag can be edited too (21 Nov 2026).
  expect(screen.getByRole('button', { name: 'Lists options' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: '+ New tag' }))
  await user.type(screen.getByLabelText('New tag name'), 'Turtle drawing{Enter}')

  await waitFor(() => expect(picks).toEqual([[['c9'], 'c9']]))
  expect(made).toEqual(['Turtle drawing'])
  expect(await screen.findByRole('button', { name: 'Turtle drawing', pressed: true })).toBeInTheDocument()
})

test('a duplicate name is refused in words, not the error colour', async () => {
  server.use(
    http.get('/api/concepts', () => HttpResponse.json([LISTS])),
    http.post('/api/concepts', () =>
      HttpResponse.json({ detail: 'There’s already a tag called Lists' }, { status: 409 }),
    ),
  )
  const { user } = renderScreen(<Harness />)
  await user.click(await screen.findByRole('button', { name: '+ New tag' }))
  await user.type(screen.getByLabelText('New tag name'), 'lists{Enter}')

  const said = await screen.findByText('There’s already a tag called Lists')
  expect(said.className).toContain('not-yet')
  expect(said.className).not.toContain('system-error')
})

test('a tag is renamed, a sub-skill added under it, and a delete says what goes with it', async () => {
  let list = [LISTS, TURTLE]
  const renames: string[] = []
  const made: Schemas['ConceptIn'][] = []
  const deleted: string[] = []
  server.use(
    http.get('/api/concepts', () => HttpResponse.json(list)),
    http.patch('/api/concepts/c2', async ({ request }) => {
      const { label } = (await request.json()) as Schemas['ConceptPatch']
      renames.push(label!)
      list = [LISTS, { ...TURTLE, label: label! }]
      return HttpResponse.json(list[1])
    }),
    http.post('/api/concepts', async ({ request }) => {
      const body = (await request.json()) as Schemas['ConceptIn']
      made.push(body)
      const child = tag({ id: 'c3', key: 'pen', label: body.label, parent_id: body.parent_id ?? null })
      list = [...list, child]
      return HttpResponse.json(child, { status: 201 })
    }),
    http.get('/api/concepts/c2/impact', () => HttpResponse.json({ subskills: 1, problems: 2, lessons: 0 })),
    http.delete('/api/concepts/c2', () => {
      deleted.push('c2')
      list = [LISTS]
      return new HttpResponse(null, { status: 204 })
    }),
  )
  const { user } = renderScreen(<Harness />)

  await user.click(await screen.findByRole('button', { name: 'Turtle options' }))
  await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
  const field = screen.getByLabelText('New name for Turtle')
  await user.clear(field)
  await user.type(field, 'Turtle graphics{Enter}')
  expect(await screen.findByRole('button', { name: 'Turtle graphics' })).toBeInTheDocument()
  expect(renames).toEqual(['Turtle graphics'])

  await user.click(screen.getByRole('button', { name: 'Turtle graphics options' }))
  await user.click(screen.getByRole('menuitem', { name: 'Add a sub-skill' }))
  await user.type(screen.getByLabelText('New sub-skill name'), 'Pen up{Enter}')
  expect(await screen.findByRole('button', { name: 'Pen up', pressed: true })).toBeInTheDocument()
  expect(made).toEqual([{ label: 'Pen up', parent_id: 'c2' }])

  await user.click(screen.getByRole('button', { name: 'Turtle graphics options' }))
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
  expect(
    await screen.findByText(
      'Its sub-skill goes with it; 2 problems will lose the tag until it’s restored. Children’s work and marks are kept.',
    ),
  ).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(deleted).toEqual(['c2']))
})

test('tags held from before the centre’s first edit follow their new ids', async () => {
  let list = [LISTS, TURTLE]
  server.use(
    http.get('/api/concepts', () => HttpResponse.json(list)),
    http.patch('/api/concepts/c1', () => {
      list = [tag({ id: 'own-lists', key: 'lists', label: 'Lists!' }), TURTLE]
      return HttpResponse.json(list[0])
    }),
  )
  const picks: [string[], string | null][] = []
  const { user } = renderScreen(<Harness onPick={(s, p) => picks.push([s, p])} />)

  await user.click(await screen.findByRole('button', { name: 'Lists' }))
  await user.click(screen.getByRole('button', { name: 'Lists options' }))
  await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
  await user.type(screen.getByLabelText('New name for Lists'), '!{Enter}')

  await waitFor(() => expect(picks.at(-1)).toEqual([['own-lists'], 'own-lists']))
  expect(await screen.findByRole('button', { name: 'Lists!', pressed: true })).toBeInTheDocument()
})
