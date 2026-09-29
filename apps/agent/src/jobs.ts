import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  validatePopupsSource,
  validateTestCaseSource,
  type FailureCode,
  type protocol,
} from '@coral/shared'
import { createPopupGuard, runTestCase, type Clock, type DeviceDriver } from '@coral/runner'
import type { Logger } from 'pino'
import type { AgentConnection } from './connection'
import type { SecretValues } from './log'
import { UploadSink } from './upload-sink'

type Assign = protocol.Payload<'job.assign'>
type JobStatus = protocol.Payload<'job.done'>['status']

/** A device driver the agent opens for a job and closes after it. */
export interface RunnableDriver extends DeviceDriver {
  open(): Promise<void>
  /** Minimal cleanup (T053): restore animations on real devices, stop u2. No uninstall, no data wipe. */
  close(): Promise<void>
}

export interface JobDeps {
  connection: Pick<AgentConnection, 'send' | 'request'>
  createDriver(input: { udid: string; appId: string }): Promise<RunnableDriver>
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

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

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

  /** Downloads the build unless this sha256 is already cached; verifies the checksum. */
  private async build(build: Assign['build']): Promise<string> {
    const dir = join(this.deps.cacheDir, 'builds')
    const path = join(dir, `${build.sha256}.apk`)
    const cached = await readFile(path).catch(() => undefined)
    if (cached && sha256(cached) === build.sha256) return path
    const res = await (this.deps.fetch ?? fetch)(build.download_url)
    if (!res.ok) throw new Error(`build download failed: HTTP ${res.status}`)
    const data = new Uint8Array(await res.arrayBuffer())
    if (sha256(data) !== build.sha256) throw new Error('build checksum mismatch')
    await mkdir(dir, { recursive: true })
    const partial = `${path}.${process.pid}.partial`
    await writeFile(partial, data)
    await rename(partial, path)
    return path
  }

  private async run(job: Assign, signal: AbortSignal): Promise<void> {
    const { connection } = this.deps
    const summary = { passed: 0, failed: 0, skipped: 0 }
    let status: JobStatus = 'passed'
    let failureCode: FailureCode | undefined
    let driver: RunnableDriver | undefined
    try {
      // Rules at the run's pinned commit; the server validated them when they were saved.
      const popups = validatePopupsSource(job.popups_yaml, 'popups.yaml').value
      if (!popups) throw new Error('popups.yaml of the run is not valid')
      const apk = await this.build(job.build)
      driver = await this.deps.createDriver({ udid: job.device_udid, appId: job.build.package })
      await driver.open()
      for (const [index, item] of job.items.entries()) {
        if (signal.aborted) {
          summary.skipped += job.items.length - index
          status = 'cancelled'
          break
        }
        const startedAt = new Date()
        const parsed = validateTestCaseSource(item.yaml, item.test_case_id)
        if (!parsed.value) {
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
      await driver
        ?.close()
        .catch((error: unknown) => this.deps.log?.warn({ err: error }, 'driver cleanup failed'))
    }
    connection.send('job.done', {
      run_id: job.run_id,
      status,
      ...(failureCode ? { failure_code: failureCode } : {}),
      summary,
    })
  }
}
