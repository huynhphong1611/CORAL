import { newId } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ApiClient, ApiError } from './client'

const session = (token: string) => ({
  access_token: token,
  expires_in: 900,
  user: { id: newId(), email: 'huynh@coral.test', name: 'Huynh' },
  tenant: { id: newId(), name: 'coral', role: 'owner' },
})

/** A fake server: `routes` answer by "METHOD path"; every call is recorded. */
function fakeFetch(routes: Record<string, (init: RequestInit) => Response>) {
  const calls: { key: string; auth: string | undefined; body: unknown }[] = []
  const impl = (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const key = `${init.method ?? 'GET'} ${url}`
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({ key, auth: headers.authorization, body: init.body })
    const route = routes[key]
    return Promise.resolve(route ? route(init) : new Response('not found', { status: 404 }))
  }
  return { impl: impl, calls }
}

const error = (status: number, code: string, message = code) =>
  Response.json({ error: { code, message } }, { status })

describe('ApiClient (research R2)', () => {
  it('logs in, keeps the token in memory and sends it', async () => {
    const seen: (string | null)[] = []
    const server = fakeFetch({
      'POST /api/auth/login': () => Response.json(session('t1')),
      'GET /api/projects': () => Response.json({ items: [] }),
    })
    const client = new ApiClient({
      fetch: server.impl,
      onSession: (s) => seen.push(s?.access_token ?? null),
    })
    await client.get('/projects', z.object({ items: z.array(z.unknown()) })).catch(() => undefined)
    expect(server.calls[0]?.auth).toBeUndefined()
    await client.login('huynh@coral.test', 'pw')
    await client.get('/projects', z.object({ items: z.array(z.unknown()) }))
    expect(server.calls.at(-1)?.auth).toBe('Bearer t1')
    expect(seen).toEqual(['t1'])
  })

  it('refreshes once on 401 and retries once', async () => {
    let token = 'old'
    const server = fakeFetch({
      'POST /api/auth/login': () => Response.json(session('old')),
      'POST /api/auth/refresh': () => ((token = 'new'), Response.json(session('new'))),
      'GET /api/me': (init) =>
        (init.headers as Record<string, string>).authorization === `Bearer ${token}` &&
        token === 'new'
          ? Response.json({ ok: true })
          : error(401, 'unauthorized'),
    })
    const client = new ApiClient({ fetch: server.impl })
    await client.login('a@b.c', 'pw')
    await expect(client.get('/me', z.object({ ok: z.boolean() }))).resolves.toEqual({ ok: true })
    expect(server.calls.map((c) => c.key)).toEqual([
      'POST /api/auth/login',
      'GET /api/me',
      'POST /api/auth/refresh',
      'GET /api/me',
    ])
  })

  it('shares one refresh between concurrent 401s', async () => {
    let refreshed = 0
    const server = fakeFetch({
      'POST /api/auth/refresh': () => ((refreshed += 1), Response.json(session('new'))),
      'GET /api/a': (init) =>
        (init.headers as Record<string, string>).authorization === 'Bearer new'
          ? Response.json(1)
          : error(401, 'x'),
      'GET /api/b': (init) =>
        (init.headers as Record<string, string>).authorization === 'Bearer new'
          ? Response.json(2)
          : error(401, 'x'),
    })
    const client = new ApiClient({ fetch: server.impl })
    await expect(
      Promise.all([client.get('/a', z.number()), client.get('/b', z.number())]),
    ).resolves.toEqual([1, 2])
    expect(refreshed).toBe(1)
  })

  it('signs out when the refresh fails and surfaces the 401', async () => {
    const seen: (string | null)[] = []
    const server = fakeFetch({
      'POST /api/auth/refresh': () => error(401, 'unauthorized'),
      'GET /api/me': () => error(401, 'unauthorized', 'missing or invalid access token'),
    })
    const client = new ApiClient({
      fetch: server.impl,
      onSession: (s) => seen.push(s?.access_token ?? null),
    })
    const failure = await client.get('/me', z.unknown()).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 401, code: 'unauthorized' })
    expect(seen).toEqual([null])
    expect(client.session).toBeNull()
  })

  it('turns error bodies into ApiError and 204 into undefined', async () => {
    const server = fakeFetch({
      'POST /api/projects': () => error(409, 'conflict', 'name taken'),
      'DELETE /api/recordings/x': () => new Response(null, { status: 204 }),
      'GET /api/broken': () => new Response('<html>', { status: 502 }),
    })
    const client = new ApiClient({ fetch: server.impl })
    await expect(client.post('/projects', { name: 'x' })).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      message: 'name taken',
    })
    await expect(client.delete('/recordings/x')).resolves.toBeUndefined()
    await expect(client.get('/broken', z.unknown())).rejects.toMatchObject({
      status: 502,
      code: 'http_error',
    })
    expect(server.calls[0]?.body).toBe('{"name":"x"}')
  })

  it('logs out even when the server call fails', async () => {
    const server = fakeFetch({ 'POST /api/auth/login': () => Response.json(session('t')) })
    const client = new ApiClient({ fetch: server.impl })
    await client.login('a@b.c', 'pw')
    await client.logout().catch(() => undefined)
    expect(client.session).toBeNull()
  })
})
