import { android } from '@coral/runner'
import { pino } from 'pino'
import { startAgent } from './agent'
import { loadConfig } from './config'

const config = loadConfig(process.env)
const log = pino({ level: config.logLevel, base: { service: 'coral-agent' } })

if (!config.agentToken) {
  log.error(
    'CORAL_AGENT_TOKEN is not set: create an agent with POST /agents and put its token in .env',
  )
  process.exit(2)
}

const adb = new android.Adb(config.adbPath)
const agent = startAgent({
  wsUrl: config.wsUrl,
  token: config.agentToken,
  cacheDir: config.cacheDir,
  devicePollMs: config.pollMs,
  log,
  source: {
    list: () => adb.devices(),
    props: (udid) => adb.device(udid).props(),
  },
  createDriver: ({ udid, appId }) =>
    android.createAndroidDriver({
      udid,
      appId,
      adbPath: config.adbPath,
      cacheDir: config.cacheDir,
      ...(config.u2JarPath ? { u2JarPath: config.u2JarPath } : {}),
    }),
  onUnauthorized: () => {
    log.error('the server refused CORAL_AGENT_TOKEN (revoked or wrong); exiting')
    process.exit(2)
  },
})
log.info({ server: config.wsUrl }, 'coral-agent started')

let stopping = false
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return
  stopping = true
  log.info({ signal }, 'shutting down: cancelling running jobs')
  await agent.stop()
  process.exit(0)
}

process.once('SIGINT', (signal) => void shutdown(signal))
process.once('SIGTERM', (signal) => void shutdown(signal))
