import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import websocket from '@fastify/websocket'
import { CORAL_VERSION, protocol, type HealthResponse, type api } from '@coral/shared'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AgentGateway } from './agents/gateway'
import { registerAuthGuard } from './auth/guard'
import { registerAuthRoutes } from './auth/routes'
import type { ServerConfig } from './config'
import type { Db } from './db/client'
import type { ProjectRepoStore } from './git/project-repo-store'
import { registerErrorHandling } from './http/errors'
import { createRepos } from './repos'
import { registerAgentRoutes, type AgentConnections } from './routes/agents'
import type { LiveControl } from './live/control'
import type { RecordingService } from './recordings/service'
import { registerBuildRoutes } from './routes/builds'
import { registerControlRoutes } from './routes/devices-control'
import { registerProjectRoutes } from './routes/projects'
import { registerRecordingRoutes } from './routes/recordings'
import { registerRunRoutes } from './routes/runs'
import { registerTestCaseRoutes } from './routes/testcases'
import type { RunDispatcher } from './runs/dispatcher'
import type { SecretSource } from './runs/secrets'
import type { ArtifactStore } from './storage/s3'
import type { UiGateway } from './ui/gateway'

/** Omitted parts disable their routes (unit tests only exercise stateless routes). */
export interface ServerDeps {
  db?: Db
  store?: ProjectRepoStore
  artifacts?: ArtifactStore
  /** `WS /ws/agent`; also closes the connection of a revoked agent. */
  gateway?: AgentGateway
  /** Only for tests without a gateway. */
  connections?: AgentConnections
  /** `WS /ws/ui`: browsers (run events, live view, control, Recorder). */
  uiGateway?: UiGateway
  /** Run creation and dispatch (queue, leases, agent assignment). */
  runs?: { dispatcher: RunDispatcher; secrets: SecretSource }
  /** Taking devices from the browser (`/devices/:id/control`, `live.command`). */
  live?: LiveControl
  /** The Recorder (`/recordings`, recording commands over `/ws/ui`). */
  recordings?: RecordingService
  /** `GET /health/ready`: true when Postgres, Redis, S3 and the data dir are usable. */
  readiness?: () => Promise<boolean>
  /** Largest build upload (config CORAL_MAX_BUILD_MB). */
  maxBuildBytes?: number
}

/** Creates the Fastify app without listening, so tests can use `app.inject()`. */
export function buildServer(
  config: Pick<ServerConfig, 'logLevel' | 'jwtSecret'> & {
    /** Where log lines go (default stdout); tests capture them. */
    logStream?: { write(line: string): void }
  },
  deps: ServerDeps = {},
): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      base: { service: 'coral-server' },
      ...(config.logStream ? { stream: config.logStream } : {}),
    },
  })
  registerErrorHandling(app)
  void app.register(cookie)
  void app.register(multipart, {
    limits: { fileSize: deps.maxBuildBytes ?? 500 * 1024 * 1024, files: 1, fields: 5 },
  })
  registerAuthGuard(app, config.jwtSecret)
  const startedAt = performance.now()

  app.get('/health', { config: { public: true } }, async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: 'coral-server',
    version: CORAL_VERSION,
    uptime_sec: Math.round(performance.now() - startedAt) / 1000,
  }))

  // Public, so it says nothing about which component failed (details go to the log only).
  app.get('/health/ready', { config: { public: true } }, async (request, reply) => {
    let ready: boolean
    try {
      ready = deps.readiness ? await deps.readiness() : true
    } catch (error) {
      request.log.error({ err: error }, 'readiness check failed')
      ready = false
    }
    return reply
      .status(ready ? 200 : 503)
      .send({ status: ready ? 'ok' : 'not_ready' } satisfies api.Readiness)
  })

  if (deps.db) registerAuthRoutes(app, { db: deps.db, jwtSecret: config.jwtSecret })
  if (deps.gateway || deps.uiGateway) {
    // One plugin for both sockets: two would both handle every HTTP upgrade. Binary live-view
    // frames are the largest messages (JSON is capped lower by each protocol's parser).
    void app.register(websocket, { options: { maxPayload: protocol.MAX_FRAME_BYTES + 64 * 1024 } })
  }
  deps.gateway?.register(app)
  deps.uiGateway?.register(app)
  if (deps.db && deps.store) {
    const repos = createRepos({ db: deps.db, store: deps.store })
    registerProjectRoutes(app, { repos })
    registerTestCaseRoutes(app, { repos })
    const connections = deps.gateway ?? deps.connections
    registerAgentRoutes(app, { repos, ...(connections ? { connections } : {}) })
    if (deps.live) registerControlRoutes(app, { repos, live: deps.live })
    if (deps.recordings) registerRecordingRoutes(app, { repos, recordings: deps.recordings })
    if (deps.artifacts) {
      registerBuildRoutes(app, { repos, artifacts: deps.artifacts })
      if (deps.runs) {
        registerRunRoutes(app, {
          repos,
          artifacts: deps.artifacts,
          dispatcher: deps.runs.dispatcher,
          queue: deps.runs.dispatcher,
          secrets: deps.runs.secrets,
        })
      }
    }
  }

  return app
}
