/**
 * Skills (Ken, 21 Nov 2026): the class grid shows each child on each concept and counts
 * what to reteach; the switches are the class's; a child's tree opens on a node's
 * evidence; and no level is ever shown in red.
 */

import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { expect, test } from 'vitest'
import type { Schemas } from '../lib/api'
import { renderScreen } from '../test/render'
import { server } from '../test/server'
import { SkillsChild } from './SkillsChild'
import { SkillsClass } from './SkillsClass'

const skill = (over: Partial<Schemas['SkillOut']> = {}): Schemas['SkillOut'] => ({
  level: 'secure',
  confident: true,
  revisit: [],
  below: false,
  evidence: 3,
  last_seen: '2026-11-20T00:00:00Z',
  ...over,
})

const SETTINGS = { slipping: true, stuck: true, stale: true }

const GRID: Schemas['ClassSkillsOut'] = {
  columns: [
    { concept_id: 'loops', label: 'Loops' },
    { concept_id: 'dicts', label: 'Dictionaries' },
  ],
  rows: [
    { student_id: 'aria', display_name: 'Aria K', cells: [skill(), skill({ level: 'learning' })] },
    {
      student_id: 'ben',
      display_name: 'Ben T',
      cells: [skill({ level: 'learning', revisit: ['slipping'] }), skill({ level: 'not_taught', evidence: 0 })],
    },
  ],
  settings: SETTINGS,
}

function grid() {
  return renderScreen(
    <Routes>
      <Route path="/classes/:classId/skills" element={<SkillsClass />} />
    </Routes>,
    { route: '/classes/c1/skills' },
  )
}

test('the grid shows each child on each concept, and counts secure and revisit per concept', async () => {
  server.use(http.get('/api/classes/c1/skills', () => HttpResponse.json(GRID)))
  grid()

  const ben = await screen.findByRole('link', { name: /Ben T, Loops: Learning, revisit \(slipping\)/ })
  expect(ben).toHaveAttribute('href', '/classes/c1/skills/ben?concept=loops')
  expect(screen.getByRole('link', { name: 'Aria K' })).toHaveAttribute('href', '/classes/c1/skills/aria')
  expect(screen.getByLabelText('Loops: 1 secure, 1 to revisit')).toHaveTextContent('1 · 1')
  expect(screen.getByLabelText('Dictionaries: 0 secure, 0 to revisit')).toBeInTheDocument()
})

test('“Revisit first” puts the children with something to revisit at the top', async () => {
  server.use(http.get('/api/classes/c1/skills', () => HttpResponse.json(GRID)))
  const { user } = grid()

  await screen.findByRole('link', { name: 'Aria K' })
  await user.click(screen.getByRole('checkbox', { name: 'Revisit first' }))
  const names = screen.getAllByRole('rowheader').map((cell) => cell.textContent)
  expect(names.slice(0, 2)).toEqual(['Ben T', 'Aria K'])
})

test('a revisit sign is switched off for the class', async () => {
  let settings = SETTINGS
  const sent: Schemas['RevisitSettingsPatch'][] = []
  server.use(
    http.get('/api/classes/c1/skills', () => HttpResponse.json({ ...GRID, settings })),
    http.patch('/api/classes/c1/skill-settings', async ({ request }) => {
      const body = (await request.json()) as Schemas['RevisitSettingsPatch']
      sent.push(body)
      settings = { ...settings, ...body } as typeof SETTINGS
      return HttpResponse.json(settings)
    }),
  )
  const { user } = grid()

  await user.click(await screen.findByRole('button', { name: 'Revisit signs' }))
  const stale = screen.getByRole('checkbox', { name: /Gone stale/ })
  expect(stale).toBeChecked()
  await user.click(stale)
  await waitFor(() => expect(sent).toEqual([{ stale: false }]))
  await waitFor(() => expect(screen.getByRole('checkbox', { name: /Gone stale/ })).not.toBeChecked())
})

const NODES: Schemas['SkillNodeOut'][] = [
  { concept_id: 'dicts', label: 'Dictionaries', parent_id: null, sort_order: 10, ...skill({ level: 'learning', below: true }) },
  { concept_id: 'values', label: '.values()', parent_id: 'dicts', sort_order: 10, ...skill({ level: 'not_yet', revisit: ['stuck'] }) },
  { concept_id: 'turtle', label: 'Turtle', parent_id: null, sort_order: 20, ...skill({ level: 'not_taught', evidence: 0 }) },
]

test('a child’s tree opens on the node the grid was clicked from, with its evidence', async () => {
  server.use(
    http.get('/api/classes/c1/students/ben/skills', () =>
      HttpResponse.json({ student_id: 'ben', display_name: 'Ben T', nodes: NODES, settings: SETTINGS }),
    ),
    http.get('/api/classes/c1/students/ben/skills/values/evidence', () =>
      HttpResponse.json([
        {
          attempt_id: 'a1',
          assignment_id: 'h1',
          assignment_title: 'Dictionaries practice',
          mode: 'homework',
          item_id: 'i1',
          item_title: 'Add up the values',
          outcome: 0.5,
          weight: 1,
          hints: 2,
          helped: false,
          marked: true,
          at: '2026-11-19T00:00:00Z',
        },
      ] satisfies Schemas['EvidenceOut'][]),
    ),
  )
  const { user } = renderScreen(
    <Routes>
      <Route path="/classes/:classId/skills/:studentId" element={<SkillsChild />} />
    </Routes>,
    { route: '/classes/c1/skills/ben?concept=values' },
  )

  // The child is the root; what they haven't met is left off until asked for.
  expect(await screen.findByLabelText('Ben T’s skill tree')).toHaveTextContent('BTBen T')
  expect(screen.queryByRole('button', { name: /^Turtle/ })).not.toBeInTheDocument()
  await user.click(screen.getByRole('checkbox', { name: 'Show concepts not taught yet' }))
  expect(screen.getByRole('button', { name: 'Turtle: Not taught yet' })).toBeInTheDocument()

  const node = screen.getByRole('button', { name: '.values(): Not yet, revisit (stuck)' })
  expect(node).toHaveAttribute('aria-pressed', 'true')
  const said = await screen.findByText('Add up the values')
  const row = said.closest('li')!
  expect(within(row).getByText('Part way').className).toContain('not-yet')
  expect(row).toHaveTextContent('Homework · Dictionaries practice')
  expect(row).toHaveTextContent('marked · 2 hints')

  // Folding a branch keeps its flag visible on the parent.
  await user.click(screen.getByRole('button', { name: 'Hide the sub-skills of Dictionaries' }))
  expect(screen.queryByRole('button', { name: /^\.values\(\)/ })).not.toBeInTheDocument()
  expect(
    within(screen.getByRole('button', { name: /^Dictionaries:/ })).getByRole('img', {
      name: 'Revisit: Something under it needs revisiting',
    }),
  ).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Bars' }))
  expect(screen.getByRole('button', { name: /^Dictionaries: Learning/ })).toBeInTheDocument()
})
