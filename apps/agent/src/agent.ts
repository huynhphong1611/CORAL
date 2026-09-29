import { arch, platform } from 'node:os'
import { CORAL_VERSION } from '@coral/shared'
import { android, type Clock } from '@coral/runner'
import type { Logger } from 'pino'
import { DeviceCommands } from './commands'
import { AgentConnection } from './connection'
import { DeviceWatcher, type DeviceSource } from './devices'
import { DeviceSessions, type SessionDriver } from './device-sessions'
import { JobManager } from './jobs'
import type { SecretValues } from './log'
import { Streamer } from './streamer'

export interface AgentOptions {
  wsUrl: string
  token: string
  source: DeviceSource
  /** A driver for the whole device; jobs bind their app with forApp(). */
  createDriver(input: { udid: string }): Promise<SessionDriver>
  /** How long an unused device session stays open (default 60 s). */
  sessionIdleMs?: number
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
 * coral-agent (SPEC §15): one WebSocket to the server, the adb device watcher, the job runner,
 * the live-view streamer and remote commands, wired together. No AI here (P1).
 */
export function startAgent(options: AgentOptions) {
  const holder: { jobs?: JobManager; streamer?: Streamer; commands?: DeviceCommands } = {}
  const watcher = new DeviceWatcher({
    source: options.source,
    busy: (udid) => holder.jobs?.busy(udid) ?? false,
    // While disconnected there is nothing to update: the next hello carries the full list.
    onUpdate: (update) => {
      for (const udid of update.removed) void holder.streamer?.stop(udid)
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
    onMessage: (message) => {
      if (message.type === 'stream.start') holder.streamer?.start(message.payload)
      else if (message.type === 'stream.stop') void holder.streamer?.stop(message.payload.udid)
      else if (message.type === 'device.command')
        holder.commands?.handle(message.id, message.payload)
      else holder.jobs?.handle(message)
    },
    ...(options.log ? { log: options.log } : {}),
    ...(options.minBackoffMs ? { minBackoffMs: options.minBackoffMs } : {}),
    ...(options.maxBackoffMs ? { maxBackoffMs: options.maxBackoffMs } : {}),
    ...(options.onUnauthorized ? { onUnauthorized: options.onUnauthorized } : {}),
  })
  const sessions = new DeviceSessions({
    createDriver: (udid) => options.createDriver({ udid }),
    ...(options.sessionIdleMs !== undefined ? { idleMs: options.sessionIdleMs } : {}),
    ...(options.log ? { log: options.log } : {}),
  })
  const jobs = new JobManager({
    connection,
    sessions,
    cacheDir: options.cacheDir,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.log ? { log: options.log } : {}),
    ...(options.secrets ? { secrets: options.secrets } : {}),
  })
  const streamer = new Streamer({
    sessions,
    send: (frame) => connection.sendBinary(frame),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.log ? { log: options.log } : {}),
  })
  const commands = new DeviceCommands({
    connection,
    sessions,
    busy: (udid) => jobs.busy(udid),
    ...(options.secrets ? { secrets: options.secrets } : {}),
    ...(options.log ? { log: options.log } : {}),
  })
  holder.jobs = jobs
  holder.streamer = streamer
  holder.commands = commands
  watcher.start()
  connection.start()

  return {
    connection,
    jobs,
    sessions,
    streamer,
    commands,
    watcher,
    /** Graceful stop: running jobs are cancelled and get up to 10 s to report job.done. */
    async stop(): Promise<void> {
      watcher.stop()
      jobs.cancelAll()
      await Promise.race([
        jobs.drain(),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref()),
      ])
      await streamer.stopAll()
      await sessions.closeAll()
      await connection.stop()
    },
  }
}

export type Agent = ReturnType<typeof startAgent>
