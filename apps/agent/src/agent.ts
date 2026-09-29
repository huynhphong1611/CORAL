import { arch, platform } from 'node:os'
import { CORAL_VERSION } from '@coral/shared'
import { android, type Clock } from '@coral/runner'
import type { Logger } from 'pino'
import { AgentConnection } from './connection'
import { DeviceWatcher, type DeviceSource } from './devices'
import { JobManager, type RunnableDriver } from './jobs'
import type { SecretValues } from './log'

export interface AgentOptions {
  wsUrl: string
  token: string
  source: DeviceSource
  createDriver(input: { udid: string; appId: string }): Promise<RunnableDriver>
  cacheDir: string
  log?: Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>
  /** Secrets of the jobs, for the redacting logger (createAgentLogger). */
  secrets?: SecretValues
  fetch?: typeof fetch
  clock?: Clock
  devicePollMs?: number
  minBackoffMs?: number
  maxBackoffMs?: number
  onUnauthorized?: () => void
}

export const SHUTDOWN_GRACE_MS = 10_000

/**
 * coral-agent (SPEC §15): one WebSocket to the server, the adb device watcher and the job runner,
 * wired together. No AI here (P1).
 */
export function startAgent(options: AgentOptions) {
  const holder: { jobs?: JobManager } = {}
  const watcher = new DeviceWatcher({
    source: options.source,
    busy: (udid) => holder.jobs?.busy(udid) ?? false,
    // While disconnected there is nothing to update: the next hello carries the full list.
    onUpdate: (update) => {
      if (connection.connected) connection.send('device.update', update)
    },
    ...(options.devicePollMs ? { intervalMs: options.devicePollMs } : {}),
    ...(options.log ? { log: options.log } : {}),
  })
  const connection = new AgentConnection({
    url: options.wsUrl,
    token: options.token,
    hello: async () => {
      await watcher.poll()
      return {
        agent_version: CORAL_VERSION,
        os: platform(),
        arch: arch(),
        capabilities: { platforms: ['android'], u2_jar: android.U2_PINS.version },
        devices: watcher.devices(),
      }
    },
    heartbeat: () => ({ devices: watcher.statuses() }),
    onMessage: (message) => holder.jobs?.handle(message),
    ...(options.log ? { log: options.log } : {}),
    ...(options.minBackoffMs ? { minBackoffMs: options.minBackoffMs } : {}),
    ...(options.maxBackoffMs ? { maxBackoffMs: options.maxBackoffMs } : {}),
    ...(options.onUnauthorized ? { onUnauthorized: options.onUnauthorized } : {}),
  })
  const jobs = new JobManager({
    connection,
    createDriver: (input) => options.createDriver(input),
    cacheDir: options.cacheDir,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.log ? { log: options.log } : {}),
    ...(options.secrets ? { secrets: options.secrets } : {}),
  })
  holder.jobs = jobs
  watcher.start()
  connection.start()

  return {
    connection,
    jobs,
    watcher,
    /** Graceful stop: running jobs are cancelled and get up to 10 s to report job.done. */
    async stop(): Promise<void> {
      watcher.stop()
      jobs.cancelAll()
      await Promise.race([
        jobs.drain(),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref()),
      ])
      await connection.stop()
    },
  }
}

export type Agent = ReturnType<typeof startAgent>
