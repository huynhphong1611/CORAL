import { createHash } from 'node:crypto'
import { imagePaths, referencedSecrets, validateTestCaseSource, type protocol } from '@coral/shared'
import { DelayedError, Queue, Worker, type ConnectionOptions, type Job } from 'bullmq'
import type { FastifyBaseLogger } from 'fastify'
import type { AgentGateway } from '../agents/gateway'
import type { Db } from '../db/client'
import type { ProjectRepoStore } from '../git/project-repo-store'
import { POPUPS_PATH } from '../repos/projects'
import { runControl, runHolder, type RunControl, type RunNotifier } from '../repos/run-control'
import type { RunRow } from '../repos/runs'
import { assetKey } from '../storage/keys'
import type { ArtifactStore } from '../storage/s3'
import type { RunQueue } from './create'
import type { SecretSource } from './secrets'

export const DISPATCH_QUEUE = 'run-dispatch'
export const TIMEOUT_QUEUE = 'run-timeout'

interface DispatchData {
  runId: string
  /** Busy/offline retries so far (drives the 2 s → 10 s backoff). */
  attempt: number
  /** job.assign without job.ack so far; one retry is allowed (research R9). */
  ackMisses: number
}

export type AckResult =
  /** `started`: the run went from queued to running (false when it was cancelled meanwhile). */
  { kind: 'ack'; started: boolean } | { kind: 'reject'; reason: string } | { kind: 'timeout' }

export interface DispatcherOptions {
  db: Db
  gateway: AgentGateway
  artifacts: ArtifactStore
  store: ProjectRepoStore
  secrets: SecretSource
  redisUrl: string
  /** BullMQ key prefix (tests use one per suite). */
  prefix?: string
  queueTimeoutMs: number
  runTimeoutMs: number
  ackTimeoutMs?: number
  retryMinMs?: number
  retryMaxMs?: number
  stableTimeoutMs?: number
  leaseTtlMs?: number
  /** Pushes run and device changes to browsers (T020). */
  notify?: RunNotifier
  log?: FastifyBaseLogger
}

export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url)
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    db: Number(u.pathname.slice(1) || 0),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  }
}

/**
 * Hands queued runs to devices (research R9): takes the device lease (the partial unique index
 * guarantees one open lease per device), sends `job.assign`, waits for `job.ack`, and schedules
 * the run timeout. Busy or offline devices are retried with backoff until the queue timeout.
 */
export class RunDispatcher implements RunQueue {
  private readonly control: RunControl
  private readonly dispatchQueue: Queue<DispatchData>
  private readonly timeoutQueue: Queue<{ runId: string }>
  private readonly workers: Worker[] = []
  private readonly acks = new Map<string, (result: AckResult) => void>()

  constructor(private readonly options: DispatcherOptions) {
    this.control = runControl(options.db, options.notify)
    const common = {
      connection: redisConnection(options.redisUrl),
      ...(options.prefix ? { prefix: options.prefix } : {}),
    }
    this.dispatchQueue = new Queue<DispatchData>(DISPATCH_QUEUE, common)
    this.timeoutQueue = new Queue<{ runId: string }>(TIMEOUT_QUEUE, common)
    this.workers.push(
      new Worker<DispatchData>(DISPATCH_QUEUE, (job, token) => this.dispatch(job, token), {
        ...common,
        concurrency: 50,
      }),
      new Worker<{ runId: string }>(TIMEOUT_QUEUE, (job) => this.timeout(job.data.runId), {
        ...common,
        concurrency: 10,
      }),
    )
    for (const worker of this.workers) {
      worker.on('failed', (job, error) =>
        options.log?.error({ err: error, job: job?.id }, 'run queue job failed'),
      )
    }
  }

  private get leaseTtlMs(): number {
    return this.options.leaseTtlMs ?? this.options.gateway.leaseTtlMs
  }

  async enqueue(runId: string): Promise<void> {
    await this.dispatchQueue.add(
      'dispatch',
      { runId, attempt: 0, ackMisses: 0 },
      { jobId: runId, removeOnComplete: true, removeOnFail: 1000 },
    )
  }

  /** Uses the server's logger once the app exists. */
  attachLogger(log: FastifyBaseLogger): void {
    this.options.log = log
  }

  /** Redis answers within 2 s (readiness). */
  async ping(): Promise<boolean> {
    const timeout = new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), 2000).unref(),
    )
    const probe = this.dispatchQueue.getJobCounts('waiting').then(
      () => true,
      () => false,
    )
    return Promise.race([probe, timeout])
  }

  /** Called by the agent channel when the owning agent answers a job.assign. */
  ackReceived(runId: string, result: AckResult): void {
    this.acks.get(runId)?.(result)
  }

  async close(): Promise<void> {
    for (const resolve of this.acks.values()) resolve({ kind: 'timeout' })
    await Promise.all(this.workers.map((w) => w.close()))
    await this.dispatchQueue.close()
    await this.timeoutQueue.close()
  }

  /** Removes everything this dispatcher put in Redis (tests). */
  async obliterate(): Promise<void> {
    await this.dispatchQueue.obliterate({ force: true })
    await this.timeoutQueue.obliterate({ force: true })
  }

  // --- cancel ------------------------------------------------------------------------------

  /** POST /runs/:id/cancel: queued → cancelled now; running → job.cancel, the agent ends it. */
  async cancel(run: RunRow, reason: string): Promise<'cancelled' | 'requested' | 'finished'> {
    if (run.status === 'queued') {
      const ended = await this.control.finishRun(run.id, 'cancelled', null)
      await this.control.releaseLease(runHolder(run.id), 'cancelled')
      return ended ? 'cancelled' : 'finished'
    }
    if (run.status !== 'running') return 'finished'
    const assignment = await this.control.assignment(run.id)
    const sent =
      assignment !== undefined &&
      this.options.gateway.send(assignment.device.agentId, 'job.cancel', {
        run_id: run.id,
        reason,
      })
    if (sent) return 'requested'
    // Nobody to tell: end it here.
    await this.control.finishRun(run.id, 'cancelled', null, 'DEVICE_OFFLINE')
    await this.control.releaseLease(runHolder(run.id), 'cancelled')
    return 'cancelled'
  }

  // --- workers -----------------------------------------------------------------------------

  private async retryLater(
    job: Job<DispatchData>,
    token: string | undefined,
    patch: Partial<DispatchData> = {},
  ): Promise<never> {
    const min = this.options.retryMinMs ?? 2000
    const max = this.options.retryMaxMs ?? 10_000
    const delay = Math.min(max, min * 2 ** job.data.attempt)
    await job.updateData({ ...job.data, ...patch, attempt: job.data.attempt + 1 })
    await job.moveToDelayed(Date.now() + delay, token)
    throw new DelayedError()
  }

  private async dispatch(job: Job<DispatchData>, token: string | undefined): Promise<void> {
    const { runId } = job.data
    const assignment = await this.control.assignment(runId)
    if (!assignment || assignment.run.status !== 'queued') return
    const { run, device } = assignment

    if (Date.now() - run.queuedAt.getTime() >= this.options.queueTimeoutMs) {
      await this.control.finishRun(runId, 'error', 'TIMEOUT')
      return
    }

    const online = this.options.gateway.isOnline(device.agentId) && device.status !== 'offline'
    const leaseId = online
      ? await this.control.acquireLease({
          tenantId: run.tenantId,
          deviceId: device.id,
          holderRef: runHolder(runId),
          ttlMs: this.leaseTtlMs,
        })
      : undefined
    if (!leaseId) return this.retryLater(job, token)

    let payload: protocol.Payload<'job.assign'>
    try {
      payload = await this.assignmentPayload(assignment)
    } catch (error) {
      this.options.log?.error({ err: error, run: runId }, 'cannot build job.assign')
      await this.control.releaseLease(runHolder(runId), 'cancelled')
      await this.control.finishRun(runId, 'error', 'DRIVER_ERROR')
      return
    }

    const answer = this.waitForAck(runId)
    if (!this.options.gateway.send(device.agentId, 'job.assign', payload)) {
      this.acks.delete(runId)
      await this.control.releaseLease(runHolder(runId), 'agent_offline')
      return this.retryLater(job, token)
    }
    const result = await answer

    if (result.kind === 'ack') {
      if (result.started) {
        await this.timeoutQueue.add(
          'timeout',
          { runId },
          { jobId: `timeout-${runId}`, delay: this.options.runTimeoutMs, removeOnComplete: true },
        )
      } else {
        // Cancelled while waiting for the ack.
        this.options.gateway.send(device.agentId, 'job.cancel', {
          run_id: runId,
          reason: 'cancelled',
        })
        await this.control.releaseLease(runHolder(runId), 'cancelled')
      }
      return
    }

    if (result.kind === 'reject') {
      this.options.log?.warn({ run: runId, reason: result.reason }, 'agent rejected the job')
      await this.control.releaseLease(runHolder(runId), 'cancelled')
      return this.retryLater(job, token)
    }

    await this.control.releaseLease(runHolder(runId), 'ack_timeout')
    if (job.data.ackMisses >= 1) {
      await this.control.finishRun(runId, 'error', 'TIMEOUT')
      return
    }
    return this.retryLater(job, token, { ackMisses: job.data.ackMisses + 1 })
  }

  private waitForAck(runId: string): Promise<AckResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => finish({ kind: 'timeout' }),
        this.options.ackTimeoutMs ?? 30_000,
      )
      const finish = (result: AckResult) => {
        clearTimeout(timer)
        this.acks.delete(runId)
        resolve(result)
      }
      this.acks.set(runId, finish)
    })
  }

  private async assignmentPayload(
    a: NonNullable<Awaited<ReturnType<RunControl['assignment']>>>,
  ): Promise<protocol.Payload<'job.assign'>> {
    const { run, device, build, app } = a
    const read = async (path: string, commit: string) => {
      const yaml = await this.options.store.readFile(run.tenantId, run.projectId, path, commit)
      if (yaml === null) throw new Error(`${path} missing at ${commit}`)
      return yaml
    }
    const rows = await this.control.itemsWithPaths(run.id)
    const names = new Set<string>()
    const items = await Promise.all(
      rows.map(async ({ item, pathInRepo }) => {
        const yaml = await read(pathInRepo, item.commit)
        const parsed = validateTestCaseSource(yaml, item.id).value
        if (parsed) for (const name of referencedSecrets(parsed)) names.add(name)
        return {
          run_item_id: item.id,
          test_case_id: item.testCaseId,
          commit: item.commit,
          yaml,
          assets: parsed ? await this.assets(run, imagePaths(parsed), item.commit) : [],
        }
      }),
    )
    return {
      run_id: run.id,
      device_udid: device.udid,
      build: {
        build_id: build.id,
        package: app.packageOrBundleId,
        download_url: (await this.options.artifacts.presignGet(build.artifactKey)).url,
        sha256: build.checksumSha256,
      },
      items,
      popups_yaml: await read(POPUPS_PATH, run.popupsCommit),
      secrets: this.options.secrets.get([...names]),
      limits: {
        run_timeout_ms: this.options.runTimeoutMs,
        stable_timeout_ms: this.options.stableTimeoutMs ?? 3000,
      },
    }
  }

  /**
   * The reference images of `image` locators, read from the project repo at the item's commit and
   * handed to the agent by content (research R12, FR-022): `<tenant>/assets/<sha256>`, uploaded
   * once, fetched through a presigned URL. A missing file fails the assignment.
   */
  private async assets(
    run: RunRow,
    paths: readonly string[],
    commit: string,
  ): Promise<protocol.Payload<'job.assign'>['items'][number]['assets']> {
    return Promise.all(
      paths.map(async (path) => {
        const bytes = await this.options.store.readBytes(run.tenantId, run.projectId, path, commit)
        if (!bytes) throw new Error(`${path} missing at ${commit}`)
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const key = assetKey(run.tenantId, sha256)
        if ((await this.options.artifacts.size(key)) === undefined) {
          await this.options.artifacts.putBytes(key, bytes, 'image/png')
        }
        return { path, sha256, download_url: (await this.options.artifacts.presignGet(key)).url }
      }),
    )
  }

  /** Run timeout (research R9): tell the agent to stop and end the run as TIMEOUT. */
  private async timeout(runId: string): Promise<void> {
    const assignment = await this.control.assignment(runId)
    if (!assignment || assignment.run.status !== 'running') return
    this.options.gateway.send(assignment.device.agentId, 'job.cancel', {
      run_id: runId,
      reason: 'timeout',
    })
    await this.control.finishRun(runId, 'error', 'TIMEOUT')
    await this.control.releaseLease(runHolder(runId), 'timeout')
  }

  /** Removes the pending timeout of a finished run. */
  async clearTimeout(runId: string): Promise<void> {
    await this.timeoutQueue.remove(`timeout-${runId}`).catch(() => undefined)
  }
}
