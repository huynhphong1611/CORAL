import type { protocol } from '@coral/shared'
import type { FastifyBaseLogger } from 'fastify'
import type { Db } from '../db/client'
import { deviceViews } from '../devices/views'
import { HttpError } from '../http/errors'
import { agentsRepo } from '../repos/agents'
import { runControl, type RunNotifier } from '../repos/run-control'
import { runsRepo } from '../repos/runs'
import type { UiGateway } from './gateway'

type RunUpdated = protocol.UiPayload<'run.updated'>
type RunStep = protocol.UiPayload<'run.step'>

/** Runs one browser tab may watch at once. */
export const MAX_WATCHES_PER_CONNECTION = 100

export interface RunEventsOptions {
  db: Db
  ui: UiGateway
  /** Device changes of a tenant within this window are sent once (default 50 ms). */
  devicesDelayMs?: number
  log?: FastifyBaseLogger
}

/**
 * Pushes run progress and device state to browsers (contracts/ui-ws.md, T020): `run.watch`
 * subscribes a tab to one run of its tenant — it gets the current state, then `run.updated` and
 * `run.step` in the order the changes happened; `devices.updated` goes to every tab of the tenant
 * whenever a lease or a device changes.
 */
export class RunEvents implements RunNotifier {
  private readonly watchers = new Map<string, Set<string>>()
  private readonly watching = new Map<string, Set<string>>()
  private readonly chains = new Map<string, Promise<void>>()
  private readonly pendingDevices = new Map<string, NodeJS.Timeout>()
  private readonly control

  constructor(private readonly options: RunEventsOptions) {
    this.control = runControl(options.db)
    options.ui.on('run.watch', async (ctx, message) => {
      const runId = message.payload.run_id
      try {
        await runsRepo(options.db, ctx.connection.user.tenantId).get(runId)
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) {
          ctx.fail('not_found', 'run not found')
          return
        }
        throw error
      }
      const mine = this.watching.get(ctx.connection.id) ?? new Set<string>()
      if (!mine.has(runId) && mine.size >= MAX_WATCHES_PER_CONNECTION) {
        ctx.fail('too_many_watches', `at most ${MAX_WATCHES_PER_CONNECTION} runs per connection`)
        return
      }
      mine.add(runId)
      this.watching.set(ctx.connection.id, mine)
      const set = this.watchers.get(runId) ?? new Set<string>()
      set.add(ctx.connection.id)
      this.watchers.set(runId, set)
      // The state now, behind any change already on its way: nothing between the REST read
      // and the watch is lost.
      const connectionId = ctx.connection.id
      this.enqueue(runId, () => this.sendRun(runId, [connectionId]))
    })
    options.ui.on('run.unwatch', (ctx, message) => {
      this.unwatch(ctx.connection.id, message.payload.run_id)
    })
    options.ui.onClose((connection) => {
      for (const runId of this.watching.get(connection.id) ?? []) {
        this.unwatch(connection.id, runId)
      }
      this.watching.delete(connection.id)
    })
  }

  runChanged(runId: string): void {
    if (!this.watchers.has(runId)) return
    this.enqueue(runId, () => this.sendRun(runId))
  }

  stepAdded(runId: string, step: Parameters<RunNotifier['stepAdded']>[1]): void {
    if (!this.watchers.has(runId)) return
    const payload: RunStep = {
      run_id: runId,
      run_item_id: step.runItemId,
      step_index: step.stepIndex,
      step_id: step.stepId,
      status: step.status,
      ...(step.failureCode ? { failure_code: step.failureCode as RunStep['failure_code'] } : {}),
      degraded: step.degraded ?? false,
      duration_ms: step.durationMs,
    }
    this.enqueue(runId, () => {
      this.send(runId, 'run.step', payload)
      return Promise.resolve()
    })
  }

  devicesChanged(tenantId: string): void {
    if (this.pendingDevices.has(tenantId)) return
    if (this.options.ui.connectionsOf(tenantId).length === 0) return
    const timer = setTimeout(() => {
      this.pendingDevices.delete(tenantId)
      deviceViews({ agents: agentsRepo(this.options.db, tenantId) })
        .then((devices) =>
          this.options.ui.broadcastToTenant(tenantId, 'devices.updated', { devices }),
        )
        .catch((error: unknown) =>
          this.options.log?.warn({ err: error, tenant: tenantId }, 'devices.updated failed'),
        )
    }, this.options.devicesDelayMs ?? 50)
    timer.unref()
    this.pendingDevices.set(tenantId, timer)
  }

  /** The server's logger, once the app exists. */
  attachLogger(log: FastifyBaseLogger): void {
    this.options.log = log
  }

  stop(): void {
    for (const timer of this.pendingDevices.values()) clearTimeout(timer)
    this.pendingDevices.clear()
  }

  private unwatch(connectionId: string, runId: string): void {
    this.watching.get(connectionId)?.delete(runId)
    const set = this.watchers.get(runId)
    set?.delete(connectionId)
    if (set?.size === 0) this.watchers.delete(runId)
  }

  /** Changes of one run are sent one after the other, in the order they happened. */
  private enqueue(runId: string, task: () => Promise<void>): void {
    const next = (this.chains.get(runId) ?? Promise.resolve())
      .then(task)
      .catch((error: unknown) =>
        this.options.log?.warn({ err: error, run: runId }, 'run event failed'),
      )
    this.chains.set(runId, next)
    void next.then(() => {
      if (this.chains.get(runId) === next) this.chains.delete(runId)
    })
  }

  private async sendRun(runId: string, only?: string[]): Promise<void> {
    const run = await this.control.getRun(runId)
    if (!run) return
    const items = await this.control.items(runId)
    const payload: RunUpdated = {
      run_id: run.id,
      status: run.status,
      ...(run.failureCode ? { failure_code: run.failureCode as RunUpdated['failure_code'] } : {}),
      items: items.map((item) => ({
        id: item.id,
        status: item.status,
        ...(item.failureCode
          ? { failure_code: item.failureCode as RunUpdated['failure_code'] }
          : {}),
        ...(item.failedStepId ? { failed_step_id: item.failedStepId } : {}),
      })),
      ...(run.startedAt ? { started_at: run.startedAt.toISOString() } : {}),
      ...(run.finishedAt ? { finished_at: run.finishedAt.toISOString() } : {}),
    }
    this.send(runId, 'run.updated', payload, only)
  }

  private send<T extends 'run.updated' | 'run.step'>(
    runId: string,
    type: T,
    payload: protocol.UiPayload<T>,
    only?: string[],
  ): void {
    const set = this.watchers.get(runId)
    for (const connectionId of only ?? [...(set ?? [])]) {
      if (!set?.has(connectionId)) continue
      if (!this.options.ui.sendTo(connectionId, type, payload)) this.unwatch(connectionId, runId)
    }
  }
}
