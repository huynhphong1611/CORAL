import { newId } from '@coral/shared'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import * as data from '../testing/data'
import { renderApp, resetFakes } from '../testing/render-app'

afterEach(() => {
  cleanup()
  resetFakes()
})

const huynh = { user_id: newId(), name: 'Huynh' }
const lan = { user_id: newId(), name: 'Lan' }
const since = '2026-09-29T08:00:00.000Z'

const activityOf = (model: string) => {
  const row = screen.getByRole('cell', { name: model }).closest('tr') as HTMLElement
  return within(row).getAllByRole('cell').at(-1)?.textContent
}

describe('devices page (T023)', () => {
  it('shows what every device is doing (contracts/web-ui.md)', async () => {
    const runId = newId()
    await renderApp('/devices', {
      routes: {
        'GET /devices': [
          data.device('Pixel 8'),
          data.device('Pixel 7', { kind: 'run', run_id: runId, by: huynh, since }),
          data.device('Galaxy S23', { kind: 'live', by: lan, since }),
          data.device('Galaxy A54', { kind: 'recording', by: huynh, since }),
          data.device('Pixel 6', { kind: 'exploration', exploration_id: newId(), by: lan, since }),
          data.device('Moto G', { kind: 'offline' }),
        ],
      },
    })
    expect(await screen.findByRole('table', { name: 'Devices' })).toBeDefined()
    expect(activityOf('Pixel 8')).toBe('idle')
    expect(activityOf('Pixel 7')).toBe(`busy · run ${runId.slice(-8)}by Huynh`)
    expect(screen.getByRole('link', { name: runId.slice(-8) }).getAttribute('href')).toBe(
      `/runs/${runId}`,
    )
    expect(activityOf('Galaxy S23')).toBe('controlled by Lan')
    expect(activityOf('Galaxy A54')).toBe('recording by Huynh')
    expect(activityOf('Pixel 6')).toBe('exploring by Lan')
    expect(activityOf('Moto G')).toBe('offline')
    expect(screen.getAllByText('Android 14')).toHaveLength(6)
  })

  it('updates live from devices.updated, without polling', async () => {
    const pixel = data.device('Pixel 8')
    const { server, requests } = await renderApp('/devices', {
      routes: { 'GET /devices': [pixel] },
    })
    expect(await screen.findByRole('cell', { name: 'Pixel 8' })).toBeDefined()
    expect(activityOf('Pixel 8')).toBe('idle')
    act(() =>
      server?.reply('devices.updated', {
        devices: [
          { ...pixel, status: 'leased', activity: { kind: 'live', by: lan, since } },
          data.device('Pixel 9'),
        ],
      }),
    )
    await waitFor(() => expect(activityOf('Pixel 8')).toBe('controlled by Lan'))
    expect(screen.getByRole('cell', { name: 'Pixel 9' })).toBeDefined()
    expect(requests.filter((r) => r.url.pathname === '/api/devices')).toHaveLength(1)
  })

  it('explains how to add a device when there is none', async () => {
    await renderApp('/devices', { routes: { 'GET /devices': [] } })
    expect(await screen.findByText(/Start coral-agent next to a device/)).toBeDefined()
  })
})
