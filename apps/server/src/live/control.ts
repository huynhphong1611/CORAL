import { newId, type api, type protocol } from '@coral/shared'
import type { FastifyBaseLogger } from 'fastify'
import type { AgentGateway, AgentRef } from '../agents/gateway'
import type { Db } from '../db/client'
import { activityOf } from '../devices/views'
import { HttpError } from '../http/errors'
import { agentsRepo } from '../repos/agents'
import { liveHolder, liveRepo, openSessionsOnAgent, type LiveSessionView } from '../repos/live'
import { runControl, type RunNotifier } from '../repos/run-control'
import type { SecretSource } from '../runs/secrets'
import type { UiContext, UiGateway } from '../ui/gateway'
import type { AgentCommands, CommandResult } from './agent-commands'

type DeviceCommand = protocol.DeviceCommand
type AgentCommand = protocol.Payload<'device.command'>['command']
type EndReason = protocol.UiPayload<'live.ended'>['reason']

const LEASE_REASON = {
  released: 'released',
  idle_timeout: 'timeout',
  agent_offline: 'agent_offline',
  replaced_by_recording: 'replaced_by_recording',
} as const

export interface LiveControlOptions {
  db: Db
  ui: Pick<UiGateway, 'on' | 'broadcastToTenant'>
  agents: Pick<AgentGateway, 'isOnline' | 'onAgentOffline'>
  commands: Pick<AgentCommands, 'send'>
  secrets: SecretSource
  /** A session ends after this long without a command (CORAL_LIVE_IDLE_MS). */
  idleMs: number
  notify?: RunNotifier
  log?: FastifyBaseLogger
}

export interface Caller {
  tenantId: string
  userId: string
}

const failed = (code: string, message: string): CommandResult['error'] => ({ code, message })

/**
 * Live control (US3, research R7): a person takes a device with a `live` lease — nothing else
 * runs on it meanwhile; queued runs wait (SC-006) — and sends the closed list of commands over
 * `/ws/ui`. Every command is recorded without the text typed (FR-009) and keeps the session
 * alive; `idleMs` without one, or the agent going away, ends it and tells the holder.
 */
export class LiveControl {
  constructor(private readonly options: LiveControlOptions) {
    options.ui.on('live.command', (ctx, message) => this.command(ctx, message.payload))
    options.agents.onAgentOffline((agent) => this.agentGone(agent))
  }

  attachLogger(log: FastifyBaseLogger): void {
    this.options.log = log
  }

  /** POST /devices/:id/control → 201, or 409 `device_busy` (with the activity) / `device_offline`. */
  async take(caller: Caller, deviceId: string): Promise<api.ControlSession> {
    const agents = agentsRepo(this.options.db, caller.tenantId)
    const device = await agents.getDevice(deviceId)
    if (device.status === 'offline' || !this.options.agents.isOnline(device.agentId)) {
      throw new HttpError(409, 'device_offline', 'the device is offline')
    }
    const session = await liveRepo(this.options.db, caller.tenantId).open(
      deviceId,
      caller.userId,
      this.options.idleMs,
    )
    if (!session) {
      const lease = (await agents.openLeases()).find((l) => l.deviceId === deviceId)
      throw new HttpError(409, 'device_busy', 'the device is busy', undefined, {
        activity: activityOf(device, lease),
      })
    }
    this.options.notify?.devicesChanged(caller.tenantId)
    return this.view(session)
  }

  /** GET /devices/:id/control: the open session, or undefined. */
  async current(tenantId: string, deviceId: string): Promise<api.ControlSession | undefined> {
    await agentsRepo(this.options.db, tenantId).getDevice(deviceId)
    const session = await liveRepo(this.options.db, tenantId).current(deviceId)
    return session ? this.view(session) : undefined
  }

  /** DELETE /devices/:id/control: only the holder lets go (403 for anyone else). */
  async release(caller: Caller, deviceId: string): Promise<void> {
    await agentsRepo(this.options.db, caller.tenantId).getDevice(deviceId)
    const session = await liveRepo(this.options.db, caller.tenantId).current(deviceId)
    if (!session) throw new HttpError(404, 'not_found', 'no control session on this device')
    if (session.userId !== caller.userId) {
      throw new HttpError(403, 'forbidden', 'only the person controlling the device can release it')
    }
    await this.end(session, 'released')
  }

  /** For the lease sweeper: an expired `live:` lease ends its session as idle_timeout. */
  async expire(lease: { holderRef: string; tenantId: string }): Promise<boolean> {
    if (!lease.holderRef.startsWith('live:')) return false
    const session = await liveRepo(this.options.db, lease.tenantId).get(lease.holderRef.slice(5))
    if (!session) return false
    await this.end(session, 'idle_timeout')
    return true
  }

  /** Ends a session: releases its lease, frees the device, tells the holder's tabs. */
  async end(session: LiveSessionView, reason: EndReason): Promise<void> {
    const ended = await liveRepo(this.options.db, session.tenantId).end(session.id, reason)
    await runControl(this.options.db, this.options.notify).releaseLease(
      liveHolder(session.id),
      LEASE_REASON[reason],
    )
    if (!ended) return
    this.options.log?.info(
      { session: session.id, device: session.deviceId, reason },
      'live control ended',
    )
    this.options.ui.broadcastToTenant(
      session.tenantId,
      'live.ended',
      { live_session_id: session.id, reason },
      (connection) => connection.user.userId === session.userId,
    )
  }

  private view(session: LiveSessionView): api.ControlSession {
    return {
      live_session_id: session.id,
      device_id: session.deviceId,
      user: { id: session.userId, name: session.userName },
      started_at: session.startedAt.toISOString(),
      expires_at: session.expiresAt.toISOString(),
      idle_timeout_ms: this.options.idleMs,
    }
  }

  private async agentGone(agent: AgentRef): Promise<void> {
    for (const session of await openSessionsOnAgent(this.options.db, agent.id)) {
      await this.end(session, 'agent_offline')
    }
  }

  /** `live.command` from the holder's tab → `device.command` → `live.result` (re = the command). */
  private async command(
    ctx: UiContext,
    payload: protocol.UiPayload<'live.command'>,
  ): Promise<void> {
    const started = Date.now()
    const commandId = newId()
    const answer = (error?: CommandResult['error']) =>
      ctx.reply('live.result', {
        ok: error === undefined,
        ...(error ? { error } : {}),
        command_id: commandId,
        duration_ms: Date.now() - started,
      })
    const { user } = ctx.connection
    if (user.role === 'viewer') return answer(failed('forbidden', 'viewers cannot control devices'))
    if (!payload.live_session_id) {
      return answer(failed('unsupported', 'recording commands arrive with the Recorder'))
    }
    const repo = liveRepo(this.options.db, user.tenantId)
    const session = await repo.get(payload.live_session_id)
    if (!session || session.userId !== user.userId) {
      return answer(failed('not_holder', 'you do not control this device'))
    }
    if (session.endedAt) return answer(failed('session_ended', 'the control session has ended'))
    const device = await agentsRepo(this.options.db, user.tenantId).getDevice(session.deviceId)
    if (device.status === 'offline' || !this.options.agents.isOnline(device.agentId)) {
      return answer(failed('device_offline', 'the device is offline'))
    }
    const prepared = await this.prepare(payload.command, repo, session.deviceId)
    if ('error' in prepared) return answer(prepared.error)
    await repo.recordCommand({
      id: commandId,
      deviceId: session.deviceId,
      liveSessionId: session.id,
      userId: user.userId,
      kind: payload.command.kind,
      params: prepared.params,
    })
    await repo.touch(session.id, this.options.idleMs)
    const result = await this.options.commands.send(device.agentId, {
      commandId,
      udid: device.udid,
      command: prepared.command,
    })
    await repo.finishCommand(commandId, result.ok ? 'ok' : 'failed', result.error?.code)
    return answer(result.ok ? undefined : result.error)
  }

  /**
   * What the agent gets and what is stored (FR-009): typed text stays out of `params` (only its
   * length, or the secret's name); a secret's value is filled in here and never sent to a browser.
   */
  private async prepare(
    command: DeviceCommand,
    repo: ReturnType<typeof liveRepo>,
    deviceId: string,
  ): Promise<
    | { command: AgentCommand; params: Record<string, unknown> }
    | { error: NonNullable<CommandResult['error']> }
  > {
    switch (command.kind) {
      case 'type': {
        if (command.secret !== undefined) {
          const value = this.options.secrets.get([command.secret])[command.secret]
          if (value === undefined) {
            return {
              error: { code: 'missing_secret', message: `secret ${command.secret} is not set` },
            }
          }
          return {
            command: { kind: 'type', text: value, redact: [value], secret: command.secret },
            params: { secret: command.secret },
          }
        }
        const text = command.text ?? ''
        return { command: { kind: 'type', text, redact: [] }, params: { length: text.length } }
      }
      case 'restart_app': {
        const pkg = await repo.lastAppPackage(deviceId)
        if (!pkg) {
          return { error: { code: 'no_app', message: 'no app has run on this device yet' } }
        }
        return { command: { kind: 'restart_app', package: pkg }, params: { package: pkg } }
      }
      default:
        return {
          command,
          params: Object.fromEntries(Object.entries(command).filter(([key]) => key !== 'kind')),
        }
    }
  }
}
