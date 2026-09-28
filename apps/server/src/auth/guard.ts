import type { FastifyInstance, FastifyRequest } from 'fastify'
import { HttpError } from '../http/errors'
import { verifyAccessToken, type AccessClaims } from './tokens'

export interface AuthContext {
  userId: string
  tenantId: string
  role: AccessClaims['role']
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null
  }
  interface FastifyContextConfig {
    /** Route reachable without an access token (health, auth, agent WS with its own token). */
    public?: boolean
  }
}

/** Default-deny: every route needs a valid access token unless it sets `config.public` (FR-017). */
export function registerAuthGuard(app: FastifyInstance, jwtSecret: string): void {
  app.decorateRequest('auth', null)
  app.addHook('onRequest', async (request: FastifyRequest) => {
    if (request.routeOptions.config.public === true || request.routeOptions.url === undefined)
      return
    const header = request.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    const claims = token ? await verifyAccessToken(token, jwtSecret) : null
    if (!claims) throw new HttpError(401, 'unauthorized', 'missing or invalid access token')
    request.auth = { userId: claims.sub, tenantId: claims.tid, role: claims.role }
  })
}

/** The authenticated context of a protected route. */
export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new HttpError(401, 'unauthorized', 'missing or invalid access token')
  return request.auth
}
