/**
 * The child's side of Help (Ken's decision, 11 Oct 2026): while a teacher helps, the
 * editor is locked; when they stop — or the connection drops — it unlocks.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { liveSockets, server } from '../test/server'
import { closeStudentLive } from './socket'
import { useLiveDoc } from './useLiveDoc'

const TARGET = 'document:018f0000-0000-7000-8000-0000000000d1'

function Editor() {
  const live = useLiveDoc(TARGET, 'print(1)\n')
  return <p>{live.locked ? 'locked' : 'unlocked'}</p>
}

afterEach(() => closeStudentLive())

test('help on locks the editor and help off unlocks it', async () => {
  let send: (message: unknown) => void = () => {}
  server.use(
    liveSockets.addEventListener('connection', ({ client }) => {
      send = (message) => client.send(JSON.stringify(message))
    }),
  )
  render(<Editor />)
  expect(await screen.findByText('unlocked')).toBeInTheDocument()

  await waitFor(() => {
    send({ type: 'help', target: TARGET, on: true })
    expect(screen.getByText('locked')).toBeInTheDocument()
  })
  send({ type: 'help', target: TARGET, on: false })
  expect(await screen.findByText('unlocked')).toBeInTheDocument()
})

test('a help message for another editor does not lock this one', async () => {
  let send: (message: unknown) => void = () => {}
  server.use(
    liveSockets.addEventListener('connection', ({ client }) => {
      send = (message) => client.send(JSON.stringify(message))
    }),
  )
  render(<Editor />)
  await screen.findByText('unlocked')
  await new Promise((resolve) => setTimeout(resolve, 50))
  send({ type: 'help', target: 'document:someone-else', on: true })
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(screen.getByText('unlocked')).toBeInTheDocument()
})
