import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('App', () => {
  it('renders in jsdom and shows the server health', async () => {
    const health = { status: 'ok', service: 'coral-server', version: '0.1.0', uptime_sec: 3 }
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json(health)))
    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>,
    )
    expect(screen.getByRole('heading', { name: 'coral' })).toBeDefined()
    expect(await screen.findByText(/version 0\.1\.0/)).toBeDefined()
  })
})
