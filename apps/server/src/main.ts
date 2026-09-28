import { loadConfig } from './config'
import { createDatabase } from './db/client'
import { buildServer } from './server'
import { createArtifactStore } from './storage/s3'

const config = loadConfig(process.env)
const database = createDatabase(config.databaseUrl)
const artifacts = createArtifactStore(config.s3)
await artifacts.ensureBucket()
const app = buildServer(config, { db: database.db })

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'shutting down')
  await app.close()
  await database.close()
  process.exit(0)
}

process.once('SIGINT', (signal) => void shutdown(signal))
process.once('SIGTERM', (signal) => void shutdown(signal))

await app.listen({ host: config.host, port: config.port })
