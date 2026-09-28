import { CORAL_VERSION, type HealthResponse } from '@coral/shared'
import Fastify, { type FastifyInstance } from 'fastify'
import type { ServerConfig } from './config'

/** Creates the Fastify app without listening, so tests can use `app.inject()`. */
export function buildServer(config: Pick<ServerConfig, 'logLevel'>): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel, base: { service: 'coral-server' } },
  })
  const startedAt = performance.now()

  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: 'coral-server',
    version: CORAL_VERSION,
    uptime_sec: Math.round(performance.now() - startedAt) / 1000,
  }))

  return app
}
