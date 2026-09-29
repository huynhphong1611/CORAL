import type { protocol } from '@coral/shared'
import type { DeviceDriver, RemoteControl } from '@coral/runner'
import type { Logger } from 'pino'
import type { AgentConnection } from './connection'
import type { DeviceSessions } from './device-sessions'
import type { SecretValues } from './log'

type DeviceCommand = protocol.Payload<'device.command'>
type AgentCommand = DeviceCommand['command']

/** Defaults when the browser does not say (contracts/ui-ws.md). */
export const LONG_PRESS_MS = 800
export const SWIPE_MS = 300

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
}

/**
 * `device.command` on the agent (US3, contracts/agent-ws-phase2.md): the closed list of what a
 * person controlling a device may do (FR-008), run one after the other per device on the shared
 * device session, each answered by `device.command_result`. Typed text is never logged.
 */
export class DeviceCommands {
  private readonly queues = new Map<string, Promise<void>>()

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
      const lease = await this.options.sessions.acquire(udid)
      try {
        await perform(lease.driver, command)
      } finally {
        await lease.release()
      }
      this.options.log?.debug(
        { udid, kind: command.kind, ms: Date.now() - started },
        'device command done',
      )
      this.options.connection.send(
        'device.command_result',
        { command_id: commandId, ok: true },
        messageId,
      )
    } catch (error) {
      const code = error instanceof CommandError ? error.code : 'command_failed'
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
}

async function perform(
  driver: DeviceDriver & Partial<RemoteControl>,
  command: AgentCommand,
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
    case 'prepare':
    case 'record':
    case 'inspect':
      throw new CommandError('unsupported', `${command.kind} is not available yet`)
  }
}
