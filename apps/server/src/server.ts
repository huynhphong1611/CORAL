import cookie from '@fastify/cookie'
import { CORAL_VERSION, type HealthResponse } from '@coral/shared'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerAuthGuard } from './auth/guard'
import { registerAuthRoutes } from './auth/routes'
import type { ServerConfig } from './config'
import type { Db } from './db/client'
import { registerErrorHandling } from './http/errors'

export interface ServerDeps {
  /** Omitted in unit tests that only exercise stateless routes. */
  db?: Db
}

/** Creates the Fastify app without listening, so tests can use `app.inject()`. */
export function buildServer(
  config: Pick<ServerConfig, 'logLevel' | 'jwtSecret'>,
  deps: ServerDeps = {},
): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel, base: { service: 'coral-server' } },
  })
  registerErrorHandling(app)
  void app.register(cookie)
  registerAuthGuard(app, config.jwtSecret)
  const startedAt = performance.now()

  app.get('/health', { config: { public: true } }, async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: 'coral-server',
    version: CORAL_VERSION,
    uptime_sec: Math.round(performance.now() - startedAt) / 1000,
  }))

  if (deps.db) registerAuthRoutes(app, { db: deps.db, jwtSecret: config.jwtSecret })

  return app
}
