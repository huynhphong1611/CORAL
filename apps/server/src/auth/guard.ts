import type { FastifyInstance, FastifyRequest } from 'fastify'
import { HttpError } from '../http/errors'
import { verifyAccessToken, type AccessClaims } from './tokens'

export interface AuthContext {
  userId: string
  tenantId: string
  role: AccessClaims['role']
}

type Role = AccessClaims['role']

/** Roles that may change things (FR-002a): hold devices, record, save test cases, start runs. */
export const WRITER_ROLES: readonly Role[] = ['owner', 'admin', 'member']
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null
  }
  interface FastifyContextConfig {
    /** Route reachable without an access token (health, auth, agent WS with its own token). */
    public?: boolean
    /**
     * Roles allowed on this route. Default: anyone for GET/HEAD, WRITER_ROLES for every other
     * method — a viewer can look but never change anything (FR-002a, research R13).
     */
    roles?: readonly Role[]
  }
}

/** Throws 403 `forbidden` unless the caller has one of `roles`. */
export function requireRole(auth: AuthContext, roles: readonly Role[]): void {
  if (!roles.includes(auth.role)) {
    throw new HttpError(403, 'forbidden', `the ${auth.role} role cannot do this`)
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
    const roles =
      request.routeOptions.config.roles ??
      (READ_METHODS.has(request.method) ? undefined : WRITER_ROLES)
    if (roles) requireRole(request.auth, roles)
  })
}

/** The authenticated context of a protected route. */
export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new HttpError(401, 'unauthorized', 'missing or invalid access token')
  return request.auth
}
