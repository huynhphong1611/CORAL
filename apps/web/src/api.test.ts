import { describe, expect, it } from 'vitest'
import { fetchHealth } from './api'

const healthy = { status: 'ok', service: 'coral-server', version: '0.1.0', uptime_sec: 3 }

describe('fetchHealth', () => {
  it('calls the proxied API and validates the payload', async () => {
    const fakeFetch: typeof fetch = (input) => {
      expect(input).toBe('/api/health')
      return Promise.resolve(Response.json(healthy))
    }
    await expect(fetchHealth(fakeFetch)).resolves.toEqual(healthy)
  })

  it('rejects an unexpected payload', async () => {
    const fakeFetch: typeof fetch = () => Promise.resolve(Response.json({ hello: 'world' }))
    await expect(fetchHealth(fakeFetch)).rejects.toThrow()
  })

  it('rejects an HTTP error', async () => {
    const fakeFetch: typeof fetch = () => Promise.resolve(new Response('down', { status: 502 }))
    await expect(fetchHealth(fakeFetch)).rejects.toThrow('HTTP 502')
  })
})
