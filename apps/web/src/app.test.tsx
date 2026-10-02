import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { safeNext } from './routes/login'
import { calls, renderApp, resetFakes, session, type FakeRequest } from './testing/render-app'

afterEach(() => {
  cleanup()
  resetFakes()
})

/** Login accepts one password. */
const login = ({ body }: FakeRequest) =>
  (body as { password: string }).password === 'right'
    ? session()
    : Response.json(
        { error: { code: 'invalid_credentials', message: 'email or password is wrong' } },
        { status: 401 },
      )

describe('web app shell (T017, T021)', () => {
  it('sends a signed-out visitor to /login?next=… and back after signing in', async () => {
    const { router } = await renderApp('/devices', {
      signedIn: false,
      routes: { 'POST /auth/login': login, 'GET /devices': [] },
    })
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
    await renderApp('/login', { signedIn: false, routes: { 'POST /auth/login': login } })
    await userEvent.type(await screen.findByLabelText('Email'), 'nobody@coral.test')
    await userEvent.type(screen.getByLabelText('Password'), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Invalid email or password')
  })

  it('keeps the session across a reload and shows user, role and navigation', async () => {
    const { router } = await renderApp('/', {
      role: 'viewer',
      routes: { 'GET /projects': [] },
    })
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects'))
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(nav.textContent).toBe('ProjectsDevicesRunsAI')
    expect(screen.getByText('Huynh')).toBeDefined()
    expect(screen.getByText('Viewer')).toBeDefined()
  })

  it('signs out to the login page', async () => {
    const { router, requests } = await renderApp('/devices', { routes: { 'GET /devices': [] } })
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(calls(requests)).toContain('POST /auth/logout')
  })

  it('only follows same-app paths after login', () => {
    expect(safeNext('/runs/123')).toBe('/runs/123')
    expect(safeNext('//evil.example')).toBe('/projects')
    expect(safeNext('https://evil.example')).toBe('/projects')
    expect(safeNext(undefined)).toBe('/projects')
  })
})
