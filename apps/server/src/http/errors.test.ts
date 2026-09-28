import { api } from '@coral/shared'
import Fastify from 'fastify'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { HttpError, formatPath, notFound, parseInput, registerErrorHandling } from './errors'

const app = Fastify({ logger: false })
registerErrorHandling(app)
app.post('/things', async (request) =>
  parseInput(
    z.object({ name: z.string(), steps: z.array(z.object({ id: z.string() })) }),
    request.body,
  ),
)
app.get('/things/:id', async () => {
  throw notFound('thing')
})
app.get('/conflict', async () => {
  throw new HttpError(409, 'conflict', 'base_commit is stale')
})
app.get('/boom', async () => {
  throw new Error('secret internals')
})
afterAll(() => app.close())

async function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
  })
  return { status: res.statusCode, body: api.apiErrorSchema.parse(res.json()) }
}

describe('HTTP errors (contracts/rest-api.md)', () => {
  it('formats Zod paths like steps[3].target', () => {
    expect(formatPath(['steps', 3, 'target', 1])).toBe('steps[3].target[1]')
  })

  it('returns 400 validation_failed with details', async () => {
    const { status, body } = await call('POST', '/things', { steps: [{}] })
    expect(status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.details?.map((d) => d.path)).toEqual(['name', 'steps[0].id'])
  })

  it('returns 400 for malformed JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/things',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'bad_request' } })
  })

  it('returns 404 for unknown resources and routes', async () => {
    expect((await call('GET', '/things/42')).body.error.code).toBe('not_found')
    expect((await call('GET', '/nope')).status).toBe(404)
  })

  it('passes HttpError status and code through', async () => {
    expect(await call('GET', '/conflict')).toMatchObject({
      status: 409,
      body: { error: { code: 'conflict' } },
    })
  })

  it('hides internal errors', async () => {
    const { status, body } = await call('GET', '/boom')
    expect(status).toBe(500)
    expect(body.error.message).not.toContain('secret')
  })
})
