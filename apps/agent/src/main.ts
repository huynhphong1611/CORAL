import { pino } from 'pino'
import { loadConfig } from './config'
import { fetchServerHealth } from './server-client'

const config = loadConfig(process.env)
const log = pino({ level: config.logLevel, base: { service: 'coral-agent' } })

log.info(
  { server_url: config.serverUrl },
  'coral-agent started (Phase 0 skeleton: no devices, no jobs)',
)

let reachable: boolean | undefined

/** Logs only when reachability changes, so a missing server does not flood the output. */
async function probeServer(): Promise<void> {
  try {
    const health = await fetchServerHealth(config.serverUrl)
    if (reachable !== true) log.info({ server_version: health.version }, 'server reachable')
    reachable = true
  } catch (error) {
    if (reachable !== false) log.warn({ err: error }, 'server unreachable, will keep retrying')
    reachable = false
  }
}

await probeServer()
const timer = setInterval(() => void probeServer(), config.pollMs)

function shutdown(signal: NodeJS.Signals): void {
  clearInterval(timer)
  log.info({ signal }, 'shutting down')
  process.exit(0)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
