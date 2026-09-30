import { newId, type api } from '@coral/shared'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as data from '../../testing/data'
import { renderApp, resetFakes, type FakeAnswer, type FakeRequest } from '../../testing/render-app'

afterEach(() => {
  cleanup()
  resetFakes()
  vi.restoreAllMocks()
})

const shop = data.project('Shop')

/**
 * XMLHttpRequest for build uploads: reports half the bytes sent, then waits for the test to
 * answer (`respond`), so the progress bar can be seen.
 */
class FakeXhr {
  static last: FakeXhr | undefined
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  withCredentials = false
  status = 0
  responseText = ''
  url = ''
  headers: Record<string, string> = {}
  form: FormData | undefined
  open(_method: string, url: string) {
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }
  getResponseHeader() {
    return 'application/json'
  }
  send(form: FormData) {
    this.form = form
    FakeXhr.last = this
    this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent)
  }
  respond(status: number, body: unknown) {
    this.status = status
    this.responseText = JSON.stringify(body)
    this.onload?.()
  }
}

const createsApp = (r: FakeRequest) =>
  r.method === 'POST' && r.url.pathname === `/api/projects/${shop.id}/apps`

describe('Apps & builds (T054)', () => {
  async function openApps(role = 'owner') {
    const apps: api.App[] = []
    const routes: Record<string, FakeAnswer> = {
      'GET /projects': [shop],
      [`GET /projects/${shop.id}/apps`]: () => apps,
      [`POST /projects/${shop.id}/apps`]: (request: FakeRequest) => {
        const created = data.app(shop.id, request.body as Partial<api.App>)
        apps.push(created)
        routes[`GET /apps/${created.id}/builds`] = []
        return Response.json(created, { status: 201 })
      },
    }
    return renderApp(`/projects/${shop.id}?tab=apps`, { role, routes })
  }

  it('adds an app with its package, refusing a package that is not one', async () => {
    const { requests } = await openApps()
    const form = await screen.findByRole('form', { name: 'New app' })
    await userEvent.type(within(form).getByLabelText('App name'), 'Shop app')
    await userEvent.type(within(form).getByLabelText('Package'), 'shop')
    await userEvent.click(within(form).getByRole('button', { name: 'Add app' }))
    expect(within(form).getByRole('alert').textContent).toContain('com.example.shop')
    expect(requests.some(createsApp)).toBe(false)

    await userEvent.clear(within(form).getByLabelText('Package'))
    await userEvent.type(within(form).getByLabelText('Package'), 'com.example.shop')
    await userEvent.click(within(form).getByRole('button', { name: 'Add app' }))
    expect(await screen.findByRole('heading', { name: 'Shop app' })).toBeDefined()
    expect(requests.find(createsApp)?.body).toEqual({
      platform: 'android',
      package_or_bundle_id: 'com.example.shop',
      name: 'Shop app',
    })
  })

  it('uploads an APK with its progress, then lists the build; 413 says the limit', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const shopApp = data.app(shop.id, { name: 'Shop app' })
    const builds: api.Build[] = []
    await renderApp(`/projects/${shop.id}?tab=apps`, {
      routes: {
        'GET /projects': [shop],
        [`GET /projects/${shop.id}/apps`]: [shopApp],
        [`GET /apps/${shopApp.id}/builds`]: () => builds,
      },
    })
    const form = await screen.findByRole('form', { name: 'Upload a build of Shop app' })
    await userEvent.type(within(form).getByLabelText('Version'), '1.4.0')
    const apk = new File([new Uint8Array(64)], 'shop.apk', {
      type: 'application/vnd.android.package-archive',
    })
    await userEvent.upload(within(form).getByLabelText('APK file'), apk)
    await userEvent.click(within(form).getByRole('button', { name: 'Upload' }))

    const bar = await within(form).findByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('50')
    expect(within(form).getByRole('button', { name: 'Uploading… 50%' })).toBeDefined()
    const xhr = FakeXhr.last
    expect(xhr?.url).toBe(`/api/apps/${shopApp.id}/builds`)
    expect(xhr?.headers.authorization).toBe('Bearer token')
    expect(xhr?.form?.get('version')).toBe('1.4.0')
    expect((xhr?.form?.get('file') as File | null)?.name).toBe('shop.apk')

    const build = { ...data.build(shopApp.id, '1.4.0'), id: newId() }
    builds.push(build)
    act(() => xhr?.respond(201, build))
    expect(await within(form).findByRole('status')).toHaveProperty(
      'textContent',
      'Build 1.4.0 uploaded.',
    )
    expect(await screen.findByRole('cell', { name: '1.4.0' })).toBeDefined()
    expect(within(form).queryByRole('progressbar')).toBeNull()

    await userEvent.type(within(form).getByLabelText('Version'), '2.0.0')
    await userEvent.upload(within(form).getByLabelText('APK file'), apk)
    await userEvent.click(within(form).getByRole('button', { name: 'Upload' }))
    act(() =>
      FakeXhr.last?.respond(413, {
        error: { code: 'payload_too_large', message: 'request body too large' },
      }),
    )
    expect((await within(form).findByRole('alert')).textContent).toContain('CORAL_MAX_BUILD_MB')
  })

  it('shows no forms to a viewer', async () => {
    await openApps('viewer')
    expect(await screen.findByText(/No apps yet/)).toBeDefined()
    expect(screen.queryByRole('form', { name: 'New app' })).toBeNull()
  })
})

describe('Agents (T055)', () => {
  const TOKEN = `coral_agt_${'A'.repeat(32)}`

  it('creates an agent and shows its token once, with Copy; then revokes it', async () => {
    const agents: api.Agent[] = []
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const routes: Record<string, FakeAnswer> = {
      'GET /devices': [],
      'GET /agents': () => agents,
      'POST /agents': (request: FakeRequest) => {
        const { name } = request.body as { name: string }
        const agent: api.Agent = {
          id: newId(),
          name,
          status: 'offline',
          os: null,
          version: null,
          last_seen_at: null,
        }
        agents.push(agent)
        routes[`POST /agents/${agent.id}/revoke`] = () => new Response(null, { status: 204 })
        return Response.json({ id: agent.id, name, token: TOKEN }, { status: 201 })
      },
    }
    const { requests } = await renderApp('/devices', { routes })
    await userEvent.click(await screen.findByRole('button', { name: 'Add agent' }))
    await userEvent.type(screen.getByLabelText('Agent name'), 'lab-mac-1')
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }))
    const token = await screen.findByLabelText('Token of lab-mac-1')
    expect((token as HTMLInputElement).value).toBe(TOKEN)
    expect(screen.getByRole('alert').textContent).toContain('shown only once')
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith(TOKEN)
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeDefined()

    const table = await screen.findByRole('table', { name: 'Agents' })
    expect(within(table).getByText('lab-mac-1')).toBeDefined()
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByLabelText('Token of lab-mac-1')).toBeNull()
    expect(screen.queryByText(TOKEN)).toBeNull()

    const agent = agents[0]
    if (agent) agent.status = 'revoked'
    await userEvent.click(within(table).getByRole('button', { name: 'Revoke lab-mac-1' }))
    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.url.pathname.endsWith('/revoke'))).toBe(
        true,
      ),
    )
    expect(await within(table).findByText('revoked')).toBeDefined()
    expect(within(table).queryByRole('button', { name: 'Revoke lab-mac-1' })).toBeNull()
  })

  it('lets a viewer see agents but not add or revoke them', async () => {
    await renderApp('/devices', {
      role: 'viewer',
      routes: {
        'GET /devices': [],
        'GET /agents': [
          {
            id: newId(),
            name: 'ci',
            status: 'online',
            os: 'linux',
            version: '0.1.0',
            last_seen_at: new Date().toISOString(),
          },
        ],
      },
    })
    const table = await screen.findByRole('table', { name: 'Agents' })
    expect(within(table).getByText('linux · coral-agent 0.1.0')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Add agent' })).toBeNull()
    expect(within(table).queryByRole('button', { name: /^Revoke/ })).toBeNull()
  })
})
