import type { FastifyBaseLogger } from 'fastify'
import type { AgentContext, AgentGateway, AgentRef } from '../agents/gateway'
import type { Db } from '../db/client'
import { runControl, runHolder } from '../repos/run-control'
import type { RunRow } from '../repos/runs'
import { runItemResultKey, stepArtifactKey, stepPrefix } from '../storage/keys'
import type { ArtifactStore } from '../storage/s3'
import type { RunDispatcher } from './dispatcher'

export interface IngestDeps {
  db: Db
  gateway: AgentGateway
  dispatcher: RunDispatcher
  artifacts: ArtifactStore
  log?: FastifyBaseLogger
}

/**
 * Results from agents (contracts/ws-protocol.md). A message is only accepted from the agent whose
 * device holds the run, in the run's tenant (P5); anything else — including late messages after
 * the run ended — is ignored.
 */
export function registerIngest(deps: IngestDeps): void {
  const control = runControl(deps.db)
  const { gateway, dispatcher } = deps

  /** The run, when `ctx.agent` owns it; undefined otherwise. */
  async function ownRun(ctx: AgentContext, runId: string): Promise<RunRow | undefined> {
    const assignment = await control.assignment(runId)
    if (
      !assignment ||
      assignment.run.tenantId !== ctx.agent.tenantId ||
      assignment.device.agentId !== ctx.agent.id
    ) {
      deps.log?.warn(
        { agent: ctx.agent.id, run: runId },
        'message for a run this agent does not hold',
      )
      ctx.reply('error', {
        code: 'unknown_run',
        message: `run ${runId} is not assigned to this agent`,
      })
      return undefined
    }
    return assignment.run
  }

  async function ownItem(ctx: AgentContext, runId: string, itemId: string) {
    const run = await ownRun(ctx, runId)
    if (!run) return undefined
    const item = await control.item(itemId)
    if (!item || item.runId !== runId) {
      ctx.reply('error', {
        code: 'unknown_run_item',
        message: `item ${itemId} is not in run ${runId}`,
      })
      return undefined
    }
    return { run, item }
  }

  gateway.on('job.ack', async (ctx, message) => {
    const runId = message.payload.run_id
    if (!(await ownRun(ctx, runId))) return
    // Mark running here, before the next message of this agent (its first step.result) is read.
    const started = await control.markRunning(runId, new Date())
    dispatcher.ackReceived(runId, { kind: 'ack', started })
  })

  gateway.on('job.reject', async (ctx, message) => {
    if (await ownRun(ctx, message.payload.run_id)) {
      dispatcher.ackReceived(message.payload.run_id, {
        kind: 'reject',
        reason: message.payload.reason,
      })
    }
  })

  gateway.on('step.result', async (ctx, message) => {
    const p = message.payload
    const owned = await ownItem(ctx, p.run_id, p.run_item_id)
    if (!owned || owned.run.status !== 'running') return
    await control.startItem(p.run_item_id, p.run_id)
    await control.addStep({
      tenantId: owned.run.tenantId,
      runItemId: p.run_item_id,
      stepIndex: p.step_index,
      stepId: p.step_id,
      action: p.action,
      status: p.status,
      locatorUsedIndex: p.locator_used_index,
      degraded: p.degraded,
      unstable: p.unstable,
      durationMs: p.duration_ms,
      failureCode: p.failure_code ?? null,
      message: p.message ?? null,
      popupsHandled: p.popups_handled,
      artifactPrefix: stepPrefix(
        owned.run.tenantId,
        p.run_id,
        p.run_item_id,
        p.step_index,
        p.step_id,
      ),
    })
  })

  gateway.on('item.result', async (ctx, message) => {
    const p = message.payload
    const owned = await ownItem(ctx, p.run_id, p.run_item_id)
    if (!owned || owned.run.status !== 'running') return
    await control.finishItem({
      itemId: p.run_item_id,
      runId: p.run_id,
      status: p.status,
      failureCode: p.failure_code ?? null,
      failedStepId: p.failed_step_id ?? null,
      startedAt: new Date(p.started_at),
      finishedAt: new Date(p.finished_at),
    })
  })

  gateway.on('artifact.request_upload', async (ctx, message) => {
    const p = message.payload
    const owned = await ownItem(ctx, p.run_id, p.run_item_id)
    if (!owned || owned.run.status !== 'running') return
    const tenantId = owned.run.tenantId
    const prefix = stepPrefix(tenantId, p.run_id, p.run_item_id, p.step_index, p.step_id)
    // Keys are always built here, never taken from the agent (T062).
    const uploads = await Promise.all(
      p.files.map(async (file) => {
        const key =
          file.name === 'result.json'
            ? runItemResultKey(tenantId, p.run_id, p.run_item_id)
            : stepArtifactKey(prefix, file.name)
        const url = await deps.artifacts.presignPut(key, file.content_type, { runArtifact: true })
        return { name: file.name, url: url.url, key, expires_at: url.expiresAt.toISOString() }
      }),
    )
    ctx.reply('artifact.upload_url', { uploads })
  })

  gateway.on('job.done', async (ctx, message) => {
    const p = message.payload
    const run = await ownRun(ctx, p.run_id)
    if (!run || run.status !== 'running') return
    let status = p.status
    if (status === 'passed') {
      // A run passes only when every item passed (data-model §2).
      const counts = await control.itemCounts(p.run_id)
      if (counts.some((c) => c.status !== 'passed' && c.count > 0)) status = 'failed'
    }
    await control.finishRun(p.run_id, status, p.failure_code ?? null)
    await control.releaseLease(runHolder(p.run_id), status === 'cancelled' ? 'cancelled' : 'done')
    await dispatcher.clearTimeout(p.run_id)
  })

  // Agent gone while running: the run ends as DEVICE_OFFLINE (SC-009).
  gateway.onAgentOffline(async (agent: AgentRef) => {
    for (const { run } of await control.activeRunsOnAgent(agent.id)) {
      if (run.status !== 'running') continue
      await control.finishRun(run.id, 'error', 'DEVICE_OFFLINE', 'DEVICE_OFFLINE')
      await control.releaseLease(runHolder(run.id), 'agent_offline')
      await dispatcher.clearTimeout(run.id)
      deps.log?.warn({ run: run.id, agent: agent.id }, 'run ended: agent offline')
    }
  })
}

export const LEASE_SWEEP_MS = 30_000

/**
 * Releases leases past `expires_at` (e.g. after a server restart, when no heartbeat will ever
 * come for them): the run on it ends as DEVICE_OFFLINE, the device goes back to idle.
 * Runs once at start and then every `intervalMs`.
 */
export function startLeaseSweeper(deps: {
  db: Db
  dispatcher?: Pick<RunDispatcher, 'clearTimeout'>
  intervalMs?: number
  log?: FastifyBaseLogger
}): { stop(): void; sweep(): Promise<number> } {
  const control = runControl(deps.db)
  async function sweep(): Promise<number> {
    const expired = await control.expiredLeases(new Date())
    for (const lease of expired) {
      const runId = lease.holderRef.startsWith('run:') ? lease.holderRef.slice(4) : undefined
      if (runId) {
        await control.finishRun(runId, 'error', 'DEVICE_OFFLINE', 'DEVICE_OFFLINE')
        await deps.dispatcher?.clearTimeout(runId)
      }
      await control.releaseLease(lease.holderRef, 'timeout')
      deps.log?.warn({ lease: lease.id, holder: lease.holderRef }, 'expired lease released')
    }
    return expired.length
  }
  const run = () =>
    void sweep().catch((error: unknown) => deps.log?.error({ err: error }, 'lease sweep failed'))
  run()
  const timer = setInterval(run, deps.intervalMs ?? LEASE_SWEEP_MS)
  timer.unref()
  return { stop: () => clearInterval(timer), sweep }
}
