import { api, newId } from '@coral/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEV_JWT_SECRET, loadConfig } from '../config'
import { createDatabase } from '../db/client'
import { auditLog } from '../db/schema'
import { identityRepo } from '../repos/identity'
import { buildServer } from '../server'
import { hashPassword } from './password'

const database = createDatabase(loadConfig(process.env).databaseUrl)
const app = buildServer({ logLevel: 'silent', jwtSecret: DEV_JWT_SECRET }, { db: database.db })
const email = `owner-${newId()}@coral.test`
const password = 'correct horse battery'
let tenantId = ''

beforeAll(async () => {
  const seeded = await identityRepo(database.db).seedOwner({
    email,
    passwordHash: await hashPassword(password),
    name: 'Owner',
    tenantName: 'auth-test',
  })
  tenantId = seeded.tenantId ?? ''
})
afterAll(async () => {
  await app.close()
  await database.close()
})

const login = (body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: body as object, headers })

describe('auth', () => {
  it('rejects protected routes without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/me' })
    expect(res.statusCode).toBe(401)
    expect(api.apiErrorSchema.parse(res.json()).error.code).toBe('unauthorized')
  })

  it('logs in, sets the refresh cookie and serves /me', async () => {
    const res = await login({ email, password })
    expect(res.statusCode).toBe(200)
    const session = api.sessionSchema.parse(res.json())
    expect(session.refresh_token).toBeUndefined()
    expect(session.tenant).toMatchObject({ id: tenantId, role: 'owner' })
    const setCookie = String(res.headers['set-cookie'])
    expect(setCookie).toMatch(/coral_refresh=.+HttpOnly/)
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Path=/auth')

    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${session.access_token}` },
    })
    expect(me.statusCode).toBe(200)
    expect(api.meSchema.parse(me.json()).user.email).toBe(email)
  })

  it('rotates refresh tokens and rejects the old one', async () => {
    const first = api.sessionSchema.parse(
      (await login({ email, password }, { 'x-coral-client': 'cli' })).json(),
    )
    expect(first.refresh_token).toBeDefined()
    const refresh = (token: string | undefined) =>
      app.inject({ method: 'POST', url: '/auth/refresh', payload: { refresh_token: token } })

    const rotated = await refresh(first.refresh_token)
    expect(rotated.statusCode).toBe(200)
    const cookie = rotated.cookies.find((c) => c.name === 'coral_refresh')
    expect(cookie?.value).toBeTruthy()
    expect(cookie?.value).not.toBe(first.refresh_token)

    expect((await refresh(first.refresh_token)).statusCode).toBe(401)
    // The rotated token also works through the cookie.
    const viaCookie = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { coral_refresh: cookie?.value ?? '' },
    })
    expect(viaCookie.statusCode).toBe(200)
  })

  it('revokes the refresh token on logout', async () => {
    const session = api.sessionSchema.parse(
      (await login({ email, password }, { 'x-coral-client': 'cli' })).json(),
    )
    const out = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refresh_token: session.refresh_token },
    })
    expect(out.statusCode).toBe(204)
    const again = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: session.refresh_token },
    })
    expect(again.statusCode).toBe(401)
  })

  it('audits logins and locks the email after 10 failures', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await login({ email, password: 'wrong' })).statusCode).toBe(401)
    }
    const blocked = await login({ email, password })
    expect(blocked.statusCode).toBe(429)
    expect(api.apiErrorSchema.parse(blocked.json()).error.code).toBe('too_many_attempts')

    const actions = (
      await database.db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId))
    ).map((row) => row.action)
    expect(actions).toContain('auth.login')
    expect(actions.filter((a) => a === 'auth.login_failed')).toHaveLength(10)
  })

  it('does not reveal whether an email exists', async () => {
    const res = await login({ email: 'nobody@coral.test', password })
    expect(res.statusCode).toBe(401)
    expect(api.apiErrorSchema.parse(res.json()).error.code).toBe('invalid_credentials')
  })
})
