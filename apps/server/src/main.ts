import { loadConfig } from './config'
import { buildServer } from './server'
import { startServices } from './services'

const config = loadConfig(process.env)
const services = await startServices(config)
const app = buildServer(config, services.deps)
services.start(app.log)

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'shutting down')
  // Closes agent connections (agents go offline) before the DB and queues stop.
  await app.close()
  await services.close()
  process.exit(0)
}

process.once('SIGINT', (signal) => void shutdown(signal))
process.once('SIGTERM', (signal) => void shutdown(signal))

await app.listen({ host: config.host, port: config.port })
