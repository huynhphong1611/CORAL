import { api } from '@coral/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../db/client'
import { HttpError, parseInput } from '../http/errors'
import { audit } from '../repos/audit'
import { identityRepo } from '../repos/identity'
import { authOf } from './guard'
import { LoginLimiter } from './login-limiter'
import { hashPassword, verifyPassword } from './password'
import {
  ACCESS_TOKEN_TTL_SEC,
  REFRESH_TOKEN_TTL_SEC,
  hashToken,
  newOpaqueToken,
  signAccessToken,
} from './tokens'

export const REFRESH_COOKIE = 'coral_refresh'

let dummy: Promise<string> | undefined
const dummyHash = () => (dummy ??= hashPassword(newOpaqueToken()))

type Identity = NonNullable<
  Awaited<ReturnType<ReturnType<typeof identityRepo>['findUserWithTenant']>>
>

/** /auth/login, /auth/refresh, /auth/logout, /me (contracts/rest-api.md, D23). */
export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { db: Db; jwtSecret: string },
): void {
  const repo = identityRepo(deps.db)
  const limiter = new LoginLimiter()

  async function issueSession(request: FastifyRequest, reply: FastifyReply, identity: Identity) {
    const refreshToken = newOpaqueToken()
    const stored = await repo.createRefreshToken(
      identity.user.id,
      hashToken(refreshToken),
      new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000),
    )
    const accessToken = await signAccessToken(
      { sub: identity.user.id, tid: identity.tenant.id, role: identity.membership.role },
      deps.jwtSecret,
    )
    void reply.setCookie(REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/auth',
      maxAge: REFRESH_TOKEN_TTL_SEC,
    })
    const cli = request.headers['x-coral-client'] === 'cli'
    return {
      storedId: stored.id,
      body: {
        access_token: accessToken,
        expires_in: ACCESS_TOKEN_TTL_SEC,
        ...(cli ? { refresh_token: refreshToken } : {}),
        user: { id: identity.user.id, email: identity.user.email, name: identity.user.name },
        tenant: {
          id: identity.tenant.id,
          name: identity.tenant.name,
          role: identity.membership.role,
        },
      } satisfies api.Session,
    }
  }

  app.post('/auth/login', { config: { public: true } }, async (request, reply) => {
    const { email, password } = parseInput(api.loginRequestSchema, request.body)
    const key = email.toLowerCase()
    if (limiter.isBlocked(key)) {
      throw new HttpError(429, 'too_many_attempts', 'too many failed logins, try again later')
    }
    const identity = await repo.findUserWithTenant(key)
    // Verify against a dummy hash for unknown emails so timing does not reveal which exist.
    const ok = await verifyPassword(identity?.user.passwordHash ?? (await dummyHash()), password)
    if (!identity || !ok) {
      limiter.recordFailure(key)
      if (identity) {
        await audit(deps.db, {
          tenantId: identity.tenant.id,
          actor: `user:${identity.user.id}`,
          action: 'auth.login_failed',
        })
      }
      throw new HttpError(401, 'invalid_credentials', 'email or password is wrong')
    }
    limiter.reset(key)
    await audit(deps.db, {
      tenantId: identity.tenant.id,
      actor: `user:${identity.user.id}`,
      action: 'auth.login',
    })
    return (await issueSession(request, reply, identity)).body
  })

  app.post('/auth/refresh', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(api.refreshRequestSchema, request.body ?? {})
    const presented = body.refresh_token ?? request.cookies[REFRESH_COOKIE]
    if (!presented) throw new HttpError(401, 'unauthorized', 'missing refresh token')
    const consumed = await repo.consumeRefreshToken(hashToken(presented), new Date())
    if (!consumed)
      throw new HttpError(401, 'unauthorized', 'refresh token is invalid, expired or already used')
    const identity = await repo.findUserWithTenantByUserId(consumed.userId)
    if (!identity) throw new HttpError(401, 'unauthorized', 'user no longer exists')
    const session = await issueSession(request, reply, identity)
    await repo.linkReplacement(consumed.id, session.storedId)
    return session.body
  })

  app.post('/auth/logout', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(api.refreshRequestSchema, request.body ?? {})
    const presented = body.refresh_token ?? request.cookies[REFRESH_COOKIE]
    if (presented) await repo.revokeRefreshToken(hashToken(presented), new Date())
    void reply.clearCookie(REFRESH_COOKIE, { path: '/auth' })
    return reply.status(204).send()
  })

  app.get('/me', async (request) => {
    const { userId, tenantId } = authOf(request)
    const identity = await repo.findUserWithTenantById(userId, tenantId)
    if (!identity) throw new HttpError(401, 'unauthorized', 'user no longer exists')
    return {
      user: { id: identity.user.id, email: identity.user.email, name: identity.user.name },
      tenant: {
        id: identity.tenant.id,
        name: identity.tenant.name,
        role: identity.membership.role,
      },
    } satisfies api.Me
  })
}
