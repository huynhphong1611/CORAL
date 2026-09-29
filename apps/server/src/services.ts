import { constants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { AgentGateway } from './agents/gateway'
import type { ServerConfig } from './config'
import { createDatabase } from './db/client'
import { ProjectRepoStore } from './git/project-repo-store'
import { RunDispatcher } from './runs/dispatcher'
import { registerIngest, startLeaseSweeper } from './runs/ingest'
import { envSecrets } from './runs/secrets'
import type { ServerDeps } from './server'
import { createArtifactStore } from './storage/s3'

/**
 * Everything coral-server needs besides the HTTP app: Postgres, S3 (bucket + lifecycle), the git
 * store, the agent gateway, the BullMQ dispatcher and the result ingestion (T054).
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
  })
  registerIngest({ db: database.db, gateway, dispatcher, artifacts })

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
    runs: { dispatcher, secrets },
    readiness,
    maxBuildBytes: config.maxBuildBytes,
  }

  let sweeper: ReturnType<typeof startLeaseSweeper> | undefined
  return {
    deps,
    /** Call once the app (and its logger) exists. */
    start(log: FastifyBaseLogger) {
      dispatcher.attachLogger(log)
      sweeper = startLeaseSweeper({ db: database.db, dispatcher, log })
    },
    async close() {
      sweeper?.stop()
      await dispatcher.close()
      await database.close()
    },
  }
}
