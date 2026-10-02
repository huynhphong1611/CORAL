// A coral-agent whose only device is a drawn look-alike of My Demo App (FakeDriver + renderTree):
// live view, remote control and the Recorder work without an emulator (dev, demos, E2E).
//   pnpm dev:fake-device        # CORAL_SERVER_URL and CORAL_AGENT_TOKEN from .env
// Env: CORAL_FAKE_UDID (default fake-mydemo-1).
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startAgent } from '../apps/agent/src/agent'
import { loadConfig } from '../apps/agent/src/config'
import { SecretValues, createAgentLogger } from '../apps/agent/src/log'
import { sampleAppDriver } from './fake-device-agent'

const config = loadConfig(process.env)
const secrets = new SecretValues()
const log = createAgentLogger({ level: config.logLevel, secrets })
if (!config.agentToken) {
  log.error(
    'CORAL_AGENT_TOKEN is not set: create an agent (POST /agents) and put its token in .env',
  )
  process.exit(2)
}
const udid = process.env.CORAL_FAKE_UDID ?? 'fake-mydemo-1'

const agent = startAgent({
  wsUrl: config.wsUrl,
  token: config.agentToken,
  cacheDir: await mkdtemp(join(tmpdir(), 'coral-fake-device-')),
  devicePollMs: 60_000,
  log,
  secrets,
  source: {
    list: () => Promise.resolve([{ udid, state: 'device' }]),
    props: () =>
      Promise.resolve({
        model: 'coral fake (My Demo App)',
        osVersion: '14',
        apiLevel: 34,
        emulator: true,
      }),
  },
  createDriver: () => Promise.resolve(sampleAppDriver()),
  onUnauthorized: () => {
    log.error('the server refused CORAL_AGENT_TOKEN; exiting')
    process.exit(2)
  },
})
log.info({ server: config.wsUrl, udid }, 'fake device agent started')

async function shutdown(): Promise<void> {
  await agent.stop()
  process.exit(0)
}
process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
