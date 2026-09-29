import { newId } from '@coral/shared'
import { createMemoryHistory } from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiClient } from './api/client'
import { SessionStore } from './api/session'
import { UiSocket } from './api/ws'
import { App } from './App'
import { safeNext } from './routes/login'
import { createAppRouter } from './router'

afterEach(cleanup)

const session = (role = 'owner') => ({
  access_token: 'token',
  expires_in: 900,
  user: { id: newId(), email: 'huynh@coral.test', name: 'Huynh' },
  tenant: { id: newId(), name: 'coral', role },
})

/** App with a fake server: signed in when `signedIn`, login accepts one password. */
async function renderApp(path: string, opts: { signedIn?: boolean; role?: string } = {}) {
  const calls: string[] = []
  const fetchImpl = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const key = `${init.method ?? 'GET'} ${url}`
    calls.push(key)
    if (key === 'POST /api/auth/refresh') {
      return Promise.resolve(
        opts.signedIn
          ? Response.json(session(opts.role))
          : Response.json({ error: { code: 'unauthorized', message: 'no' } }, { status: 401 }),
      )
    }
    if (key === 'POST /api/auth/login') {
      const body = JSON.parse(init.body as string) as { password: string }
      return Promise.resolve(
        body.password === 'right'
          ? Response.json(session())
          : Response.json(
              { error: { code: 'invalid_credentials', message: 'email or password is wrong' } },
              { status: 401 },
            ),
      )
    }
    if (key === 'POST /api/auth/logout') return Promise.resolve(new Response(null, { status: 204 }))
    return Promise.resolve(
      Response.json({ error: { code: 'not_found', message: key } }, { status: 404 }),
    )
  }) as typeof fetch
  const store = new SessionStore()
  const client = new ApiClient({ fetch: fetchImpl, onSession: (s) => store.set(s) })
  const socket = new UiSocket({ url: 'ws://test/api/ws/ui', token: () => undefined })
  const context = { client, session: store, socket }
  const router = createAppRouter(context, createMemoryHistory({ initialEntries: [path] }))
  render(<App router={router} context={context} />)
  await act(() => client.refresh())
  return { router, calls, client }
}

describe('web app shell (T017)', () => {
  it('sends a signed-out visitor to /login?next=… and back after signing in', async () => {
    const { router } = await renderApp('/devices')
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined()
    expect(router.state.location.pathname).toBe('/login')
    expect(router.state.location.search).toEqual({ next: '/devices' })
    await userEvent.type(screen.getByLabelText('Email'), 'huynh@coral.test')
    await userEvent.type(screen.getByLabelText('Password'), 'right')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/devices'))
    expect(screen.getByRole('heading', { name: 'Devices' })).toBeDefined()
  })

  it('shows one generic error for wrong credentials (US1 scenario 2)', async () => {
    await renderApp('/login')
    await userEvent.type(await screen.findByLabelText('Email'), 'nobody@coral.test')
    await userEvent.type(screen.getByLabelText('Password'), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Invalid email or password')
  })

  it('keeps the session across a reload and shows user, role and navigation', async () => {
    const { router } = await renderApp('/', { signedIn: true, role: 'viewer' })
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects'))
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(nav.textContent).toBe('ProjectsDevicesRuns')
    expect(screen.getByText('Huynh')).toBeDefined()
    expect(screen.getByText('Viewer')).toBeDefined()
  })

  it('signs out to the login page', async () => {
    const { router, calls } = await renderApp('/runs', { signedIn: true })
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(calls).toContain('POST /api/auth/logout')
  })

  it('only follows same-app paths after login', () => {
    expect(safeNext('/runs/123')).toBe('/runs/123')
    expect(safeNext('//evil.example')).toBe('/projects')
    expect(safeNext('https://evil.example')).toBe('/projects')
    expect(safeNext(undefined)).toBe('/projects')
  })
})
