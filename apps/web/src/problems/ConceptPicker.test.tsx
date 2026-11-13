/**
 * The centre's own tags (Ken, 14 Nov 2026): a teacher adds one from the picker and it goes
 * on the problem; only the centre's own have a menu; a refusal is "not yet", never red.
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

const LISTS: Schemas['ConceptOut'] = { id: 'c1', key: 'lists', label: 'Lists', status: 'provisional', own: false }
const TURTLE: Schemas['ConceptOut'] = { id: 'c2', key: 'turtle', label: 'Turtle', status: 'active', own: true }

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
      const tag = { id: 'c9', key: 'turtle_drawing', label, status: 'active', own: true }
      list = [...list, tag]
      return HttpResponse.json(tag, { status: 201 })
    }),
  )
  const picks: [string[], string | null][] = []
  const { user } = renderScreen(<Harness onPick={(s, p) => picks.push([s, p])} />)

  await screen.findByRole('button', { name: 'Lists' })
  // A built-in tag has no menu.
  expect(screen.queryByRole('button', { name: 'Lists options' })).not.toBeInTheDocument()

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

test('the centre’s own tag can be renamed, and a removal it is still used for is explained', async () => {
  let list = [LISTS, TURTLE]
  const renames: string[] = []
  server.use(
    http.get('/api/concepts', () => HttpResponse.json(list)),
    http.patch('/api/concepts/c2', async ({ request }) => {
      const { label } = (await request.json()) as Schemas['ConceptIn']
      renames.push(label)
      list = [LISTS, { ...TURTLE, label }]
      return HttpResponse.json(list[1])
    }),
    http.post('/api/concepts/c2/archive', () =>
      HttpResponse.json({ detail: 'Used by 2 problems. Take the tag off them first.' }, { status: 409 }),
    ),
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
  await user.click(screen.getByRole('menuitem', { name: 'Remove' }))
  await user.click(screen.getByRole('button', { name: 'Remove tag' }))
  const said = await screen.findByText('Used by 2 problems. Take the tag off them first.')
  expect(said.className).toContain('not-yet')
})
