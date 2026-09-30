import { readFile } from 'node:fs/promises'
import {
  validatePopupsSource,
  validateTestCaseSource,
  type FailureCode,
  type protocol,
} from '@coral/shared'
import { createPopupGuard, runTestCase, type Clock, type DeviceDriver } from '@coral/runner'
import type { Logger } from 'pino'
import { cachedAsset, cachedBuild } from './builds'
import type { AgentConnection } from './connection'
import type { DeviceLease, DeviceSessions } from './device-sessions'
import type { SecretValues } from './log'
import { UploadSink } from './upload-sink'

type Assign = protocol.Payload<'job.assign'>
type JobStatus = protocol.Payload<'job.done'>['status']

export interface JobDeps {
  connection: Pick<AgentConnection, 'send' | 'request'>
  /** The device's shared session (one u2 per device, research R6). */
  sessions: Pick<DeviceSessions, 'acquire'>
  /** Builds are cached here by sha256 (`<cacheDir>/builds/<sha256>.apk`). */
  cacheDir: string
  fetch?: typeof fetch
  clock?: Clock
  log?: Pick<Logger, 'info' | 'warn' | 'error'>
  /** Every secret of every job is added here, so the agent's logger masks it (D19). */
  secrets?: SecretValues
}

interface ActiveJob {
  runId: string
  abort: AbortController
  done: Promise<void>
}

/**
 * Runs the jobs the server assigns (T053): one job per device (a second one is rejected), the
 * build is downloaded once per sha256, every test case runs with the deterministic runner and
 * its events stream back as step.result / item.result / job.done.
 */
export class JobManager {
  private readonly active = new Map<string, ActiveJob>()

  constructor(private readonly deps: JobDeps) {}

  busy(udid: string): boolean {
    return this.active.has(udid)
  }

  /** Server messages from the connection. */
  handle(message: protocol.Message): void {
    if (message.type === 'job.assign') this.assign(message.id, message.payload)
    else if (message.type === 'job.cancel') this.cancel(message.payload.run_id)
  }

  /** Waits for every running job (graceful shutdown). */
  async drain(): Promise<void> {
    await Promise.all([...this.active.values()].map((job) => job.done))
  }

  cancelAll(): void {
    for (const job of this.active.values()) job.abort.abort()
  }

  private assign(messageId: string, job: Assign): void {
    const { connection } = this.deps
    this.deps.secrets?.add(Object.values(job.secrets))
    if (this.active.has(job.device_udid)) {
      connection.send('job.reject', { run_id: job.run_id, reason: 'device busy' }, messageId)
      return
    }
    const abort = new AbortController()
    const entry: ActiveJob = { runId: job.run_id, abort, done: Promise.resolve() }
    this.active.set(job.device_udid, entry)
    connection.send('job.ack', { run_id: job.run_id }, messageId)
    entry.done = this.run(job, abort.signal)
      .catch((error: unknown) =>
        this.deps.log?.error({ err: error, run: job.run_id }, 'job crashed'),
      )
      .finally(() => this.active.delete(job.device_udid))
  }

  private cancel(runId: string): void {
    for (const job of this.active.values()) {
      if (job.runId === runId) {
        this.deps.log?.info({ run: runId }, 'cancelling job')
        job.abort.abort()
      }
    }
  }

  private async run(job: Assign, signal: AbortSignal): Promise<void> {
    const { connection } = this.deps
    const summary = { passed: 0, failed: 0, skipped: 0 }
    let status: JobStatus = 'passed'
    let failureCode: FailureCode | undefined
    let lease: DeviceLease | undefined
    try {
      // Rules at the run's pinned commit; the server validated them when they were saved.
      const popups = validatePopupsSource(job.popups_yaml, 'popups.yaml').value
      if (!popups) throw new Error('popups.yaml of the run is not valid')
      const apk = await cachedBuild(job.build, this.deps.cacheDir, this.deps.fetch)
      lease = await this.deps.sessions.acquire(job.device_udid, { appId: job.build.package })
      const driver: DeviceDriver = lease.driver
      for (const [index, item] of job.items.entries()) {
        if (signal.aborted) {
          summary.skipped += job.items.length - index
          status = 'cancelled'
          break
        }
        const startedAt = new Date()
        /** The item could not start: an error result, then the next item. */
        const itemError = () => {
          connection.send('item.result', {
            run_id: job.run_id,
            run_item_id: item.run_item_id,
            status: 'error',
            failure_code: 'DRIVER_ERROR',
            started_at: startedAt.toISOString(),
            finished_at: new Date().toISOString(),
          })
          summary.failed += 1
          status = 'error'
          failureCode ??= 'DRIVER_ERROR'
        }
        const parsed = validateTestCaseSource(item.yaml, item.test_case_id)
        if (!parsed.value) {
          itemError()
          continue
        }
        // The reference images of `image` locators, cached by sha256 (research R12).
        let files: Map<string, string>
        try {
          files = new Map(
            await Promise.all(
              item.assets.map(
                async (asset) =>
                  [
                    asset.path,
                    await cachedAsset(asset, this.deps.cacheDir, this.deps.fetch),
                  ] as const,
              ),
            ),
          )
        } catch (error) {
          this.deps.log?.error({ err: error, run: job.run_id }, 'image assets not available')
          itemError()
          continue
        }
        const result = await runTestCase({
          driver,
          testCase: parsed.value,
          popupGuard: createPopupGuard({ popups, driver }),
          appId: job.build.package,
          secrets: job.secrets,
          sink: new UploadSink(
            connection,
            { runId: job.run_id, runItemId: item.run_item_id },
            this.deps.fetch,
          ),
          stableTimeoutMs: job.limits.stable_timeout_ms,
          signal,
          assets: (path) => {
            const file = files.get(path)
            if (!file) return Promise.reject(new Error(`image ${path} did not come with the job`))
            return readFile(file)
          },
          // Install once, before the first test case (research R7).
          ...(index === 0 ? { build: { path: apk, sha256: job.build.sha256 } } : {}),
          ...(this.deps.clock ? { clock: this.deps.clock } : {}),
          onEvent: (event) => {
            if (event.type === 'step') {
              connection.send('step.result', {
                run_id: job.run_id,
                run_item_id: item.run_item_id,
                ...event.result,
              })
            }
          },
        })
        const cancelled = signal.aborted && result.status === 'error'
        const failedStep = result.steps.find((s) => s.status === 'failed')
        connection.send('item.result', {
          run_id: job.run_id,
          run_item_id: item.run_item_id,
          status: result.status,
          ...(result.failure_code ? { failure_code: result.failure_code } : {}),
          ...(failedStep ? { failed_step_id: failedStep.step_id } : {}),
          started_at: startedAt.toISOString(),
          finished_at: new Date().toISOString(),
        })
        if (cancelled) {
          summary.skipped += job.items.length - index - 1
          status = 'cancelled'
          break
        }
        if (result.status === 'passed') summary.passed += 1
        else summary.failed += 1
        if (result.status === 'error') {
          status = 'error'
          failureCode ??= result.failure_code
        } else if (result.status === 'failed' && status === 'passed') {
          status = 'failed'
          failureCode ??= result.failure_code
        }
      }
    } catch (error) {
      this.deps.log?.error(
        { err: error, run: job.run_id },
        'job failed before or between test cases',
      )
      status = signal.aborted ? 'cancelled' : 'error'
      if (!signal.aborted) failureCode = 'DRIVER_ERROR'
    } finally {
      // The session closes (animations restored, u2 stopped) once the device is idle.
      await lease?.release()
    }
    connection.send('job.done', {
      run_id: job.run_id,
      status,
      ...(failureCode ? { failure_code: failureCode } : {}),
      summary,
    })
  }
}
