import { constants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { AgentGateway } from './agents/gateway'
import { stopCopilotRuntime } from '@coral/brain'
import { providerAdapters } from './ai/adapters'
import { BrainsSettings } from './ai/brains-config'
import { AiService } from './ai/service'
import type { ServerConfig } from './config'
import { createDatabase } from './db/client'
import { ExplorationService } from './explorer/service'
import { ImportService } from './imports/service'
import { ValidationService } from './writer/validation'
import { WriterService, writeAndValidate } from './writer/service'
import { AgentCommands } from './live/agent-commands'
import { LiveControl } from './live/control'
import { deviceLookup, StreamHub } from './live/stream-hub'
import { ProjectRepoStore } from './git/project-repo-store'
import { RecordingService } from './recordings/service'
import { createRepos } from './repos'
import { RunDispatcher } from './runs/dispatcher'
import { registerIngest, startLeaseSweeper } from './runs/ingest'
import { envSecrets } from './runs/secrets'
import type { ServerDeps } from './server'
import { createArtifactStore } from './storage/s3'
import { UiGateway } from './ui/gateway'
import { RunEvents } from './ui/run-events'
import { ExplorationWatchers } from './ui/exploration-events'
import { ImportWatchers } from './ui/import-events'

/** How often expired recordings are cleaned up. */
const RECORDING_CLEANUP_MS = 60 * 60 * 1000

/**
 * Everything coral-server needs besides the HTTP app: Postgres, S3 (bucket + lifecycle), the git
 * store, the agent gateway, the BullMQ dispatcher, the result ingestion (T054) and the browser
 * socket with its run and device events (T020) and the live-view hub (T029).
 */
export async function startServices(
  config: ServerConfig,
  env: Record<string, string | undefined> = process.env,
) {
  const database = createDatabase(config.databaseUrl)
  await mkdir(config.dataDir, { recursive: true })
  const store = new ProjectRepoStore(config.dataDir)
  const artifacts = createArtifactStore(config.s3)
  await artifacts.ensureBucket()
  const gateway = new AgentGateway({ db: database.db, heartbeatMs: config.timeouts.heartbeatMs })
  const uiGateway = new UiGateway({ jwtSecret: config.jwtSecret })
  const notify = new RunEvents({ db: database.db, ui: uiGateway })
  gateway.onDevicesChanged((tenantId) => notify.devicesChanged(tenantId))
  const streams = new StreamHub({
    ui: uiGateway,
    agents: gateway,
    findDevice: deviceLookup(database.db, gateway),
  })
  const secrets = envSecrets(env)
  const dispatcher = new RunDispatcher({
    db: database.db,
    gateway,
    artifacts,
    store,
    secrets,
    redisUrl: config.redisUrl,
    queueTimeoutMs: config.timeouts.queueTimeoutMs,
    runTimeoutMs: config.timeouts.runTimeoutMs,
    notify,
  })
  registerIngest({ db: database.db, gateway, dispatcher, artifacts, notify })
  const commands = new AgentCommands(gateway)
  const live = new LiveControl({
    db: database.db,
    ui: uiGateway,
    agents: gateway,
    commands,
    secrets,
    idleMs: config.timeouts.liveIdleMs,
    notify,
  })
  const recordings = new RecordingService({
    db: database.db,
    store,
    artifacts,
    ui: uiGateway,
    agents: gateway,
    commands,
    live,
    secrets,
    idleMs: config.timeouts.liveIdleMs,
    notify,
  })
  const brains = new BrainsSettings({ ai: config.ai, secrets })
  const ai = new AiService({
    repos: createRepos({ db: database.db, store }),
    store,
    artifacts,
    settings: brains,
    secrets,
    fakeBrains: config.ai.fakeBrains,
    stdioAllowlist: config.ai.mcpStdioAllowlist,
    adapters: providerAdapters({ copilotEnabled: config.ai.copilotEnabled }),
  })
  const writer = new WriterService({ db: database.db, store, artifacts, ai })
  const validation = new ValidationService({
    db: database.db,
    store,
    secrets,
    queue: dispatcher,
  })
  const explorations = new ExplorationService({
    db: database.db,
    store,
    artifacts,
    agents: gateway,
    commands,
    ai,
    maxPerTenant: config.ai.maxExplorations,
    notify,
    events: new ExplorationWatchers({ db: database.db, ui: uiGateway }),
    writer: writeAndValidate(writer, validation, database.db),
  })
  const imports = new ImportService({
    db: database.db,
    store,
    artifacts,
    agents: gateway,
    ai,
    events: new ImportWatchers({ db: database.db, ui: uiGateway }),
  })

  const readiness = async (): Promise<boolean> => {
    const checks = await Promise.allSettled([
      database.db.execute(sql`select 1`),
      dispatcher.ping().then((ok) => (ok ? ok : Promise.reject(new Error('redis')))),
      artifacts.ready().then((ok) => (ok ? ok : Promise.reject(new Error('s3')))),
      access(config.dataDir, constants.W_OK),
    ])
    return checks.every((c) => c.status === 'fulfilled')
  }

  const deps: ServerDeps = {
    db: database.db,
    store,
    artifacts,
    gateway,
    uiGateway,
    runs: { dispatcher, secrets },
    live,
    recordings,
    explorations,
    imports,
    brains,
    mcpStdioAllowlist: config.ai.mcpStdioAllowlist,
    readiness,
    maxBuildBytes: config.maxBuildBytes,
  }

  let sweeper: ReturnType<typeof startLeaseSweeper> | undefined
  let cleanup: NodeJS.Timeout | undefined
  return {
    deps,
    /** Call once the app (and its logger) exists. */
    start(log: FastifyBaseLogger) {
      dispatcher.attachLogger(log)
      notify.attachLogger(log)
      streams.attachLogger(log)
      live.attachLogger(log)
      recordings.attachLogger(log)
      explorations.attachLogger(log)
      imports.attachLogger(log)
      writer.attachLogger(log)
      validation.attachLogger(log)
      // Explorations the last run of the server left behind (research R9, clarify 5).
      void explorations
        .recoverInterrupted()
        .then((count) => count > 0 && log.warn({ count }, 'explorations interrupted by a restart'))
        .catch((error: unknown) => log.error({ err: error }, 'exploration recovery failed'))
      sweeper = startLeaseSweeper({
        db: database.db,
        dispatcher,
        notify,
        expire: async (lease) =>
          (await live.expire(lease)) ||
          (await recordings.expire(lease)) ||
          explorations.expire(lease),
        log,
      })
      // Recordings untouched for 7 days go, with their snapshots (T043).
      const expireRecordings = () =>
        recordings
          .expireOld()
          .then((count) => count > 0 && log.info({ count }, 'recordings expired'))
          .catch((error: unknown) => log.error({ err: error }, 'recording cleanup failed'))
      void expireRecordings()
      cleanup = setInterval(() => void expireRecordings(), RECORDING_CLEANUP_MS)
      cleanup.unref()
    },
    async close() {
      sweeper?.stop()
      if (cleanup) clearInterval(cleanup)
      notify.stop()
      streams.stop()
      await dispatcher.close()
      await stopCopilotRuntime()
      await database.close()
    },
  }
}
