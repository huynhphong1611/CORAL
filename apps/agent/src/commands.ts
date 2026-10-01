import type { protocol } from '@coral/shared'
import type { DeviceDriver, RemoteControl } from '@coral/runner'
import type { Logger } from 'pino'
import { cachedBuild } from './builds'
import type { AgentConnection } from './connection'
import type { DeviceSessions } from './device-sessions'
import type { SecretValues } from './log'
import {
  LONG_PRESS_MS,
  RecorderError,
  SWIPE_MS,
  inspect,
  prepare,
  record,
  type RecorderDeps,
} from './recorder'

type DeviceCommand = protocol.Payload<'device.command'>
type AgentCommand = DeviceCommand['command']
type ControlCommand = Exclude<AgentCommand, { kind: 'prepare' | 'record' | 'inspect' | 'observe' }>

export { LONG_PRESS_MS, SWIPE_MS }

export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CommandError'
  }
}

export interface DeviceCommandsOptions {
  connection: Pick<AgentConnection, 'send'>
  sessions: Pick<DeviceSessions, 'acquire'>
  /** True while a job runs on the device: live commands must not interfere (P6). */
  busy?: (udid: string) => boolean
  /** Values to mask in logs; a secret typed into the device is added before it is used. */
  secrets?: SecretValues
  log?: Pick<Logger, 'info' | 'warn' | 'debug'>
  /** Where `prepare` caches builds (the jobs' cache: `<cacheDir>/builds/<sha256>.apk`). */
  cacheDir?: string
  fetch?: typeof fetch
  /** Recorder options (tests: a fake clock, a short stability timeout). */
  recorder?: Pick<RecorderDeps, 'clock' | 'stableTimeoutMs'>
}

/**
 * `device.command` on the agent (US3, contracts/agent-ws-phase2.md): the closed list of what a
 * person controlling a device may do (FR-008), run one after the other per device on the shared
 * device session, each answered by `device.command_result`. Typed text is never logged.
 */
export class DeviceCommands {
  private readonly queues = new Map<string, Promise<void>>()
  /** Package last prepared or recorded on each device: `inspect` writes its ids short. */
  private readonly packages = new Map<string, string>()

  constructor(private readonly options: DeviceCommandsOptions) {}

  handle(messageId: string, payload: DeviceCommand): void {
    const { udid } = payload
    const next = (this.queues.get(udid) ?? Promise.resolve()).then(() =>
      this.execute(messageId, payload),
    )
    this.queues.set(udid, next)
    void next.finally(() => {
      if (this.queues.get(udid) === next) this.queues.delete(udid)
    })
  }

  /** Waits for every queued command (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.queues.values()])
  }

  private async execute(messageId: string, payload: DeviceCommand): Promise<void> {
    const { command_id: commandId, udid, command } = payload
    const started = Date.now()
    try {
      if (this.options.busy?.(udid)) {
        throw new CommandError('device_busy', 'a run is using the device')
      }
      // Secret values are masked from now on; plain typed text is simply never logged.
      if (command.kind === 'type') this.options.secrets?.add(command.redact)
      if (command.kind === 'prepare' || command.kind === 'record' || command.kind === 'inspect') {
        // Every secret value of the tenant: masked in the snapshot's tree.json and in logs.
        this.options.secrets?.add(command.redact)
      }
      if (command.kind === 'record' && command.action.kind === 'type') {
        this.options.secrets?.add(command.action.redact)
      }
      const appId = 'package' in command ? command.package : undefined
      if (appId && (command.kind === 'prepare' || command.kind === 'record')) {
        this.packages.set(udid, appId)
      }
      const lease = await this.options.sessions.acquire(udid, appId ? { appId } : {})
      let result: Record<string, unknown> | undefined
      try {
        result = await this.perform(udid, lease.driver, command)
      } finally {
        await lease.release()
      }
      this.options.log?.debug(
        { udid, kind: command.kind, ms: Date.now() - started },
        'device command done',
      )
      this.options.connection.send(
        'device.command_result',
        { command_id: commandId, ok: true, ...(result ? { result } : {}) },
        messageId,
      )
    } catch (error) {
      const code =
        error instanceof CommandError || error instanceof RecorderError
          ? error.code
          : 'command_failed'
      const message = error instanceof Error ? error.message : String(error)
      // Only the kind is logged, never the command (typed text); the logger masks secrets.
      this.options.log?.warn(
        { udid, kind: command.kind, code, err: error },
        'device command failed',
      )
      this.options.connection.send(
        'device.command_result',
        {
          command_id: commandId,
          ok: false,
          error: { code, message: this.options.secrets?.redactor.text(message) ?? message },
        },
        messageId,
      )
    }
  }

  private async perform(
    udid: string,
    driver: DeviceDriver & Partial<RemoteControl>,
    command: AgentCommand,
  ): Promise<Record<string, unknown> | undefined> {
    if (command.kind === 'observe') {
      // The Explorer's look at the screen comes with T018.
      throw new CommandError('unsupported', 'observe is not supported by this agent yet')
    }
    if (command.kind !== 'prepare' && command.kind !== 'record' && command.kind !== 'inspect') {
      await control(driver, command)
      return undefined
    }
    const { cacheDir, secrets } = this.options
    const fetchImpl = this.options.fetch ?? fetch
    const deps: RecorderDeps = {
      driver,
      redactor: secrets?.redactor ?? { text: (t) => t, value: (v) => v },
      put: async (url, body, contentType) => {
        const res = await fetchImpl(url, {
          method: 'PUT',
          headers: { 'content-type': contentType },
          body,
        })
        if (!res.ok) throw new Error(`snapshot upload failed: HTTP ${res.status}`)
      },
      ...(cacheDir ? { build: (build) => cachedBuild(build, cacheDir, fetchImpl) } : {}),
      ...this.options.recorder,
    }
    switch (command.kind) {
      case 'prepare':
        return prepare(deps, command)
      case 'record':
        return record(deps, command)
      case 'inspect':
        return inspect(deps, { x: command.x, y: command.y }, this.packages.get(udid))
    }
  }
}

/** The plain controls of FR-008 (US3). */
async function control(
  driver: DeviceDriver & Partial<RemoteControl>,
  command: ControlCommand,
): Promise<void> {
  switch (command.kind) {
    case 'tap':
      return driver.tapAt({ x: command.x, y: command.y })
    case 'long_press':
      return driver.longPressAt({ x: command.x, y: command.y }, command.ms ?? LONG_PRESS_MS)
    case 'swipe':
      return driver.swipe(command.from, command.to, command.ms ?? SWIPE_MS)
    case 'type':
      return driver.type(command.text)
    case 'back':
      return driver.back()
    case 'home':
      if (!driver.home) throw new CommandError('unsupported', 'this device has no Home button')
      return driver.home()
    case 'hide_keyboard':
      return driver.hideKeyboard()
    case 'restart_app':
      // Only the package the server named (P6): stop it, then launch it again.
      if (!driver.stopApp) throw new CommandError('unsupported', 'cannot stop apps on this device')
      await driver.stopApp(command.package)
      return driver.launch(command.package)
  }
}
