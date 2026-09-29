import { newId, type api } from '@coral/shared'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import * as data from '../../testing/data'
import { calls, renderApp, resetFakes, type FakeRequest } from '../../testing/render-app'

afterEach(() => {
  cleanup()
  resetFakes()
})

const statusOf = (runId: string) => {
  const row = document.querySelector(`tr[data-run-id="${runId}"]`) as HTMLElement
  return within(row).getAllByRole('cell')[1]?.textContent
}

describe('runs list (T024)', () => {
  it('filters through the URL, pages, and updates active runs live', async () => {
    const shop = data.project('Shop')
    const pixel = data.device('Pixel 8')
    const running = data.run({ status: 'running', finished_at: null, device_id: pixel.id })
    const older = data.run({}, ['checkout', 'login'])
    const oldest = data.run({ status: 'failed' })
    const page = ({ url }: FakeRequest) =>
      url.searchParams.get('cursor') === older.id
        ? { items: [oldest], next_cursor: null }
        : { items: [running, older], next_cursor: older.id }
    const { requests, router, server } = await renderApp(`/runs?project_id=${shop.id}`, {
      routes: { 'GET /projects': [shop], 'GET /devices': [pixel], 'GET /runs': page },
    })
    expect(await screen.findByRole('table', { name: 'Runs' })).toBeDefined()
    expect(calls(requests)).toContain(`GET /runs?limit=20&project_id=${shop.id}`)
    expect(statusOf(running.id)).toBe('running')
    expect(
      within(document.querySelector(`tr[data-run-id="${older.id}"]`) as HTMLElement).getByText(
        'checkout, login',
      ),
    ).toBeDefined()
    expect(
      within(document.querySelector(`tr[data-run-id="${running.id}"]`) as HTMLElement).getByText(
        'Pixel 8',
      ),
    ).toBeDefined()

    // Only the active run is watched; its update lands in the list.
    await waitFor(() => expect(server?.sentTypes()).toEqual(['run.watch']))
    expect(server?.sent.at(-1)?.payload).toEqual({ run_id: running.id })
    act(() =>
      server?.reply('run.updated', {
        run_id: running.id,
        status: 'passed',
        items: running.items.map((i) => ({ id: i.id, status: 'passed' })),
        started_at: running.started_at,
        finished_at: '2026-09-29T08:01:00.000Z',
      }),
    )
    await waitFor(() => expect(statusOf(running.id)).toBe('passed'))
    await waitFor(() => expect(server?.sentTypes()).toEqual(['run.watch', 'run.unwatch']))

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(statusOf(oldest.id)).toBe('failed'))
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'failed')
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ project_id: shop.id, status: 'failed' }),
    )
    expect(calls(requests)).toContain(`GET /runs?limit=20&project_id=${shop.id}&status=failed`)
  })

  it('shows the empty state', async () => {
    await renderApp('/runs', {
      routes: {
        'GET /projects': [],
        'GET /devices': [],
        'GET /runs': { items: [], next_cursor: null },
      },
    })
    expect(await screen.findByText('No runs yet.')).toBeDefined()
  })
})

function detailRoutes(run: api.Run, steps: Record<string, api.RunStep[]>) {
  const routes: Record<string, unknown> = {
    'GET /projects': [data.project('Shop', { id: run.project_id })],
    'GET /devices': [
      data.device('Pixel 8', { kind: 'idle' }, { id: run.device_id, udid: 'emulator-5554' }),
    ],
    [`GET /runs/${run.id}`]: run,
  }
  for (const item of run.items) {
    routes[`GET /runs/${run.id}/items/${item.id}/steps`] = () => steps[item.id] ?? []
  }
  return routes as Record<string, object>
}

describe('run detail (T024)', () => {
  it('shows every step: image, status, locator used, degraded, time, popups, error', async () => {
    const run = data.run({ status: 'failed', failure_code: null }, ['login', 'checkout'])
    const [login, checkout] = run.items as [api.RunItem, api.RunItem]
    login.status = 'failed'
    login.failure_code = 'TARGET_NOT_FOUND'
    login.failed_step_id = 's3'
    checkout.status = 'skipped'
    const steps = {
      [login.id]: [
        data.step(0, { action: 'launch', locator_used_index: null }),
        data.step(1, {
          locator_used_index: 1,
          degraded: true,
          duration_ms: 12_400,
          popups_handled: [{ rule: 'camera-permission', button: 'Allow' }],
        }),
        data.step(2, {
          status: 'failed',
          failure_code: 'TARGET_NOT_FOUND',
          message: 'no element matched any locator',
        }),
      ],
    }
    await renderApp(`/runs/${run.id}`, {
      routes: {
        ...detailRoutes(run, steps),
        'GET https://s3.test/steps/2/device.log': new Response(
          'I ActivityManager: start\nE App: boom',
        ),
        'GET https://s3.test/steps/2/tree.json': [
          {
            ref: '0',
            platform_id: '',
            text: '',
            desc: '',
            class: 'android.widget.FrameLayout',
            bounds: { x: 0, y: 0, w: 1080, h: 2400 },
            clickable: false,
            enabled: true,
            visible: true,
            package_or_bundle: 'com.example.shop',
            children: [
              {
                ref: '0.0',
                platform_id: 'com.example.shop:id/login_button',
                text: 'Log in',
                desc: '',
                class: 'android.widget.Button',
                bounds: { x: 60, y: 1200, w: 960, h: 140 },
                clickable: true,
                enabled: true,
                visible: true,
                package_or_bundle: 'com.example.shop',
                children: [],
              },
            ],
          },
        ],
      },
    })
    expect(await screen.findByRole('heading', { name: `Run ${run.id.slice(-8)}` })).toBeDefined()
    expect(screen.getByTestId('run-status').textContent).toBe('failed')
    expect(await screen.findByRole('link', { name: 'Shop' })).toBeDefined()
    expect(await screen.findByText('Pixel 8 · emulator-5554')).toBeDefined()
    expect(screen.getByText('TARGET_NOT_FOUND @ s3')).toBeDefined()
    expect(screen.getByText('No steps yet.')).toBeDefined()

    const cards = await screen.findAllByRole('listitem', { name: /^Step / })
    expect(cards).toHaveLength(3)
    const [launch, tap, failed] = cards as [HTMLElement, HTMLElement, HTMLElement]
    expect(within(launch).getByText('no locator')).toBeDefined()
    expect(within(tap).getByText('locator #2')).toBeDefined()
    expect(within(tap).getByText('degraded')).toBeDefined()
    expect(within(tap).getByText('12.4 s')).toBeDefined()
    expect(within(tap).getByText('camera-permission → Allow')).toBeDefined()
    expect(within(failed).getByText(/no element matched any locator/)).toBeDefined()
    const image = within(tap).getByRole('img', { name: 'Screenshot of step s2' })
    expect(image.getAttribute('src')).toBe('https://s3.test/steps/1/screenshot.png')

    // A broken image says so instead of showing a broken icon.
    fireEvent.error(within(launch).getByRole('img'))
    expect(within(launch).getByText('Image unavailable')).toBeDefined()

    await userEvent.click(within(failed).getByRole('button', { name: 'Device log' }))
    expect((await within(failed).findByText(/E App: boom/)).textContent).toContain(
      'I ActivityManager: start',
    )
    await userEvent.click(within(failed).getByRole('button', { name: 'Element tree' }))
    const tree = await within(failed).findByRole('list', { name: 'Element tree' })
    expect(within(tree).getByText('#login_button')).toBeDefined()
    expect(within(tree).getByText('“Log in”')).toBeDefined()
  })

  it('follows an active run live: status, then steps as they come', async () => {
    const run = data.run({ status: 'running', finished_at: null })
    const item = run.items[0] as api.RunItem
    item.status = 'running'
    const steps: Record<string, api.RunStep[]> = { [item.id]: [data.step(0)] }
    const { server, requests } = await renderApp(`/runs/${run.id}`, {
      role: 'member',
      routes: detailRoutes(run, steps),
    })
    expect(await screen.findAllByRole('listitem', { name: /^Step / })).toHaveLength(1)
    expect(screen.getByText('Live')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeDefined()
    await waitFor(() => expect(server?.sentTypes()).toEqual(['run.watch']))

    steps[item.id] = [data.step(0), data.step(1)]
    act(() =>
      server?.reply('run.step', {
        run_id: run.id,
        run_item_id: item.id,
        step_index: 1,
        step_id: 's2',
        status: 'passed',
        degraded: false,
        duration_ms: 850,
      }),
    )
    await waitFor(() => expect(screen.getAllByRole('listitem', { name: /^Step / })).toHaveLength(2))
    act(() =>
      server?.reply('run.updated', {
        run_id: run.id,
        status: 'passed',
        items: [{ id: item.id, status: 'passed' }],
        started_at: run.started_at,
        finished_at: '2026-09-29T08:00:20.000Z',
      }),
    )
    await waitFor(() => expect(screen.getByTestId('run-status').textContent).toBe('passed'))
    expect(screen.queryByText('Live')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull()
    await waitFor(() => expect(server?.sentTypes()).toEqual(['run.watch', 'run.unwatch']))
    expect(calls(requests).filter((c) => c.endsWith('/steps'))).toHaveLength(2)
  })

  it('lets a member cancel an active run, not a viewer', async () => {
    const run = data.run({ status: 'queued', started_at: null, finished_at: null })
    let cancelled = false
    const routes = {
      ...detailRoutes(run, {}),
      [`GET /runs/${run.id}`]: () => (cancelled ? { ...run, status: 'cancelled' } : run),
      [`POST /runs/${run.id}/cancel`]: () => {
        cancelled = true
        return Response.json({ id: run.id, status: 'cancelled' }, { status: 202 })
      },
    }
    await renderApp(`/runs/${run.id}`, { role: 'member', routes })
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel run' }))
    await waitFor(() => expect(screen.getByTestId('run-status').textContent).toBe('cancelled'))
    cleanup()
    resetFakes()
    await renderApp(`/runs/${run.id}`, { role: 'viewer', routes: detailRoutes(run, {}) })
    expect(await screen.findByTestId('run-status')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull()
  })

  it("shows Not found for a run that is not the tenant's", async () => {
    const id = newId()
    await renderApp(`/runs/${id}`, { routes: { 'GET /projects': [], 'GET /devices': [] } })
    expect((await screen.findByRole('alert')).textContent).toMatch(/not found/i)
  })
})
