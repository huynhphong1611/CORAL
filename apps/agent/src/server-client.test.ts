import { describe, expect, it } from 'vitest'
import { fetchServerHealth } from './server-client'

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (input) => {
    expect(input).toEqual(new URL('http://localhost:3000/health'))
    return Promise.resolve(Response.json(body, { status }))
  }
}

const healthy = { status: 'ok', service: 'coral-server', version: '0.1.0', uptime_sec: 3 }

describe('fetchServerHealth', () => {
  it('returns the validated health payload', async () => {
    await expect(
      fetchServerHealth('http://localhost:3000', fakeFetch(200, healthy)),
    ).resolves.toEqual(healthy)
  })

  it('fails on a non-2xx status', async () => {
    await expect(
      fetchServerHealth('http://localhost:3000', fakeFetch(503, healthy)),
    ).rejects.toThrow('HTTP 503')
  })

  it('fails when the payload does not match the shared schema', async () => {
    await expect(
      fetchServerHealth('http://localhost:3000', fakeFetch(200, { status: 'ok' })),
    ).rejects.toThrow()
  })
})
