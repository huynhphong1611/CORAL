import { CORAL_VERSION, healthResponseSchema } from '@coral/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { DEV_JWT_SECRET } from './config'
import { buildServer } from './server'

describe('coral-server', () => {
  const app = buildServer({ logLevel: 'silent', jwtSecret: DEV_JWT_SECRET })
  afterAll(async () => {
    await app.close()
  })

  it('answers GET /health with the shared health contract', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    const body = healthResponseSchema.parse(response.json())
    expect(body.version).toBe(CORAL_VERSION)
  })

  it('returns 404 for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' })
    expect(response.statusCode).toBe(404)
  })
})
