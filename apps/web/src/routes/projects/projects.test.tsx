import type { api } from '@coral/shared'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import * as data from '../../testing/data'
import { calls, renderApp, resetFakes, type FakeRequest } from '../../testing/render-app'

afterEach(() => {
  cleanup()
  resetFakes()
})

describe('projects page (T022)', () => {
  it('shows loading, then the empty state', async () => {
    let answer: (value: object) => void = () => undefined
    await renderApp('/projects', {
      routes: { 'GET /projects': () => new Promise<object>((resolve) => (answer = resolve)) },
    })
    expect((await screen.findByRole('status')).textContent).toBe('Loading…')
    answer([])
    expect(await screen.findByText('No projects yet.')).toBeDefined()
  })

  it("shows the server's message when the list fails", async () => {
    await renderApp('/projects', {
      routes: {
        'GET /projects': Response.json(
          { error: { code: 'internal', message: 'database is down' } },
          { status: 500 },
        ),
      },
    })
    expect((await screen.findByRole('alert')).textContent).toBe('database is down')
  })

  it('lists projects and lets a member create one', async () => {
    const list: api.Project[] = [data.project('Shop')]
    const { requests } = await renderApp('/projects', {
      role: 'member',
      routes: {
        'GET /projects': () => list,
        'POST /projects': ({ body }: FakeRequest) => {
          const created = data.project((body as { name: string }).name)
          list.push(created)
          return Response.json(created, { status: 201 })
        },
      },
    })
    expect(await screen.findByRole('link', { name: 'Shop' })).toBeDefined()
    await userEvent.click(screen.getByRole('button', { name: 'New project' }))
    await userEvent.type(screen.getByLabelText('Name'), '  Wallet ')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByRole('link', { name: 'Wallet' })).toBeDefined()
    expect(
      requests.find((r) => r.method === 'POST' && r.url.pathname === '/api/projects')?.body,
    ).toEqual({ name: 'Wallet' })
    expect(calls(requests).filter((c) => c === 'GET /projects')).toHaveLength(2)
  })

  it('hides New project from a viewer', async () => {
    await renderApp('/projects', { role: 'viewer', routes: { 'GET /projects': [data.project()] } })
    expect(await screen.findByRole('link', { name: 'Shop' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull()
  })
})

function projectRoutes() {
  const shop = data.project('Shop')
  const login = data.testCase('login', { source: 'recorder' })
  const checkout = data.testCase('checkout', { status: 'draft' })
  const shopApp = data.app(shop.id)
  const builds = [data.build(shopApp.id, '1.2.0'), data.build(shopApp.id, '1.1.0')]
  const devices = [data.device('Pixel 7', { kind: 'offline' }), data.device('sdk_gphone64_x86_64')]
  const run = data.run({ project_id: shop.id, status: 'queued' })
  return {
    shop,
    login,
    checkout,
    builds,
    devices,
    run,
    routes: {
      'GET /projects': [shop],
      [`GET /projects/${shop.id}/testcases`]: [checkout, login],
      [`GET /projects/${shop.id}/apps`]: [shopApp],
      [`GET /apps/${shopApp.id}/builds`]: builds,
      'GET /devices': devices,
      'GET /runs': { items: [run], next_cursor: null },
      [`GET /runs/${run.id}`]: run,
      'POST /runs': Response.json({ id: run.id, status: 'queued', items: [] }, { status: 201 }),
    },
  }
}

describe('project page (T022, T025)', () => {
  it('lists test cases, runs, recordings and apps with builds in tabs', async () => {
    const { shop, run, routes } = projectRoutes()
    const { requests, router } = await renderApp(`/projects/${shop.id}`, { routes })
    expect(await screen.findByRole('heading', { name: 'Shop' })).toBeDefined()
    const table = await screen.findByRole('table', { name: 'Test cases' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getAllByRole('cell')[1]?.textContent)).toEqual([
      'checkout',
      'login',
    ])
    expect(within(rows[1] as HTMLElement).getByText('recorder')).toBeDefined()
    expect(within(rows[0] as HTMLElement).getByText('draft')).toBeDefined()

    await userEvent.click(screen.getByRole('tab', { name: 'Runs' }))
    expect(router.state.location.search).toEqual({ tab: 'runs' })
    expect(await screen.findByRole('link', { name: run.id.slice(-8) })).toBeDefined()
    expect(calls(requests)).toContain(`GET /runs?limit=20&project_id=${shop.id}`)

    await userEvent.click(screen.getByRole('tab', { name: 'Recordings' }))
    expect(screen.getByText(/No recordings in progress/)).toBeDefined()

    await userEvent.click(screen.getByRole('tab', { name: 'Apps & builds' }))
    const builds = await screen.findByRole('table', { name: 'Builds' })
    expect(within(builds).getByText('1.2.0')).toBeDefined()
    expect(within(builds).getAllByText('12.0 MB')).toHaveLength(2)
    expect(screen.getByText('com.example.shop')).toBeDefined()
  })

  it('says so when the project does not exist (or is another tenant’s)', async () => {
    await renderApp('/projects/0190a0b0-0000-7000-8000-000000000000', {
      routes: { 'GET /projects': [data.project()] },
    })
    expect(await screen.findByText('Project not found')).toBeDefined()
  })

  it('runs the selected test cases on a build and device, then opens the run', async () => {
    const { shop, login, checkout, builds, devices, run, routes } = projectRoutes()
    const { requests, router } = await renderApp(`/projects/${shop.id}`, { routes })
    const runSelected = await screen.findByRole('button', { name: 'Run 0 selected' })
    expect((runSelected as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(screen.getByLabelText('Select all test cases'))
    await userEvent.click(screen.getByRole('button', { name: 'Run 2 selected' }))

    const dialog = await screen.findByRole('dialog', { name: 'Run test cases' })
    expect(within(dialog).getByText('2 test cases')).toBeDefined()
    // The newest build and the idle device are picked; offline devices are not offered.
    await waitFor(() =>
      expect(within(dialog).getByLabelText<HTMLSelectElement>('Build').value).toBe(builds[0]?.id),
    )
    const device = within(dialog).getByLabelText<HTMLSelectElement>('Device')
    expect(device.value).toBe(devices[1]?.id)
    expect([...device.options].map((o) => o.textContent)).toEqual([
      `sdk_gphone64_x86_64 · ${devices[1]?.udid} · idle`,
    ])
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start run' }))

    await waitFor(() => expect(router.state.location.pathname).toBe(`/runs/${run.id}`))
    const post = requests.find((r) => r.method === 'POST' && r.url.pathname === '/api/runs')
    expect(post?.body).toEqual({
      project_id: shop.id,
      build_id: builds[0]?.id,
      device_id: devices[1]?.id,
      test_case_ids: [checkout.id, login.id],
    })
  })

  it('runs one test case from its row and shows why a run was refused', async () => {
    const { shop, login, routes } = projectRoutes()
    await renderApp(`/projects/${shop.id}`, {
      routes: {
        ...routes,
        'POST /runs': Response.json(
          { error: { code: 'missing_secrets', message: 'secrets not set: OTP_SEED' } },
          { status: 422 },
        ),
      },
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Run login' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('1 test case')).toBeDefined()
    await waitFor(() =>
      expect(
        within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Start run' }).disabled,
      ).toBe(false),
    )
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start run' }))
    expect((await within(dialog).findByRole('alert')).textContent).toBe('secrets not set: OTP_SEED')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(login.slug).toBe('login')
  })

  it('shows no Run buttons or selection to a viewer (FR-002a)', async () => {
    const { shop, routes } = projectRoutes()
    await renderApp(`/projects/${shop.id}`, { role: 'viewer', routes })
    expect(await screen.findByRole('table', { name: 'Test cases' })).toBeDefined()
    expect(screen.queryByRole('button', { name: /^Run/ })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})
