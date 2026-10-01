import {
  api,
  manualCasePath,
  manualCaseSchema,
  MAX_IMPORT_BYTES,
  parseYaml,
  referenceSecrets,
  toYaml,
  type ImportFormat,
  type ImportMapping,
  type ManualCase,
  type protocol,
} from '@coral/shared'
import type { FastifyBaseLogger } from 'fastify'
import type { AgentGateway } from '../agents/gateway'
import type { AiService } from '../ai/service'
import type { Db } from '../db/client'
import { activityOf } from '../devices/views'
import type { ExplorationService } from '../explorer/service'
import type { GitAuthor, ProjectRepoStore } from '../git/project-repo-store'
import { HttpError } from '../http/errors'
import type { Caller } from '../live/control'
import { agentsRepo } from '../repos/agents'
import { buildsRepo } from '../repos/builds'
import { explorationsRepo, type ExplorationRow } from '../repos/explorations'
import {
  importsRepo,
  runningImportJobs,
  type ImportItemPatch,
  type ImportItemRow,
  type ImportJobRow,
} from '../repos/imports'
import { projectsRepo } from '../repos/projects'
import { testCasesRepo } from '../repos/test-cases'
import { explorationStepKey, importSourceKey } from '../storage/keys'
import type { ArtifactStore } from '../storage/s3'
import type { TableRead } from './mapping'
import { formatOf, readImport } from './read'

/** Where import progress goes (`import.watch` of /ws/ui). */
export interface ImportEvents {
  emit(tenantId: string, payload: protocol.UiPayload<'import.updated'>): void
}

export interface ImportServiceOptions {
  db: Db
  store: ProjectRepoStore
  artifacts: ArtifactStore
  agents: Pick<AgentGateway, 'isOnline'>
  ai: Pick<AiService, 'ready' | 'secretValues'>
  /** Each case is a guided exploration (`kind = import`) followed by the Test writer. */
  explorations: Pick<ExplorationService, 'start' | 'stop'>
  events?: ImportEvents
  log?: FastifyBaseLogger
  /** How often a case's exploration is looked at (default 1 s). */
  pollMs?: number
  /** How long to wait before trying a busy or offline device again (default 5 s). */
  retryMs?: number
}

/** Steps an imported case may take (research R14). */
export const MAX_IMPORT_STEPS = 25
/** Longest exploration of one case, in minutes. */
const MAX_CASE_MINUTES = 20
/** Start errors that pass: the device or the tenant's slots free up. */
const WAIT_FOR = new Set(['device_busy', 'device_offline', 'too_many_explorations'])
const ENDED = new Set<ExplorationRow['status']>(['done', 'stopped', 'failed', 'interrupted'])

/**
 * What the Explorer is asked to do for a manual case: what shows it is done first, then the
 * case as written (its expected results never changed, FR-037).
 */
export function goalOf(manual: ManualCase): string {
  const last = [...manual.steps].reverse().find((s) => s.expected)?.expected
  return [
    ...(last ? [`Done when: ${last}`] : []),
    `Follow the manual test case: ${manual.title}`,
    ...manual.preconditions.map((p) => `Precondition: ${p}`),
    ...manual.steps.map(
      (s, i) => `${i + 1}. ${s.action}${s.expected ? ` → expected: ${s.expected}` : ''}`,
    ),
  ].join('\n')
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Ends a job's run early: the device or AI cannot go on (daily limit, no config). */
class JobStop extends Error {
  constructor(
    readonly status: 'cancelled' | 'failed',
    message: string,
  ) {
    super(message)
  }
}

const CONTENT_TYPES: Record<ImportFormat, string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  gherkin: 'text/plain',
}

const iso = (date: Date) => date.toISOString()
const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null)

export function jobView(row: ImportJobRow): api.ImportJob {
  return {
    id: row.id,
    project_id: row.projectId,
    app_id: row.appId,
    build_id: row.buildId,
    device_id: row.deviceId,
    source_format: row.sourceFormat,
    file_name: row.fileName,
    status: row.status,
    budget: row.budget,
    stats: row.stats,
    manual_commit: row.manualCommit,
    created_by: { id: row.createdBy, name: row.createdByName },
    created_at: iso(row.createdAt),
    started_at: isoOrNull(row.startedAt),
    finished_at: isoOrNull(row.finishedAt),
  }
}

export function itemView(row: ImportItemRow, screenshotUrl?: string): api.ImportItem {
  const evidence = row.evidence
  return {
    n: row.n,
    title: row.title,
    status: row.status,
    reason: row.reason,
    evidence: evidence
      ? {
          ...(evidence.step_n !== undefined ? { step_n: evidence.step_n } : {}),
          ...(screenshotUrl ? { screenshot_url: screenshotUrl } : {}),
          message: evidence.message,
        }
      : null,
    exploration_id: row.explorationId,
    test_case_id: row.testCaseId,
  }
}

/**
 * Imports of manual test cases (US6, research R14, contracts/manualcase.md): a file is read into
 * a preview — the columns, the mapping, the cases and the rows in error — kept until the person
 * starts it; then its cases go into the project repo as one commit and the job works through them
 * one by one on the chosen device.
 */
export class ImportService {
  /** Jobs worked through by this process. */
  private readonly running = new Set<string>()
  private readonly cancelling = new Set<string>()
  private closed = false

  constructor(private readonly options: ImportServiceOptions) {}

  attachLogger(log: FastifyBaseLogger): void {
    this.options.log = log
  }

  private repo(tenantId: string) {
    return importsRepo(this.options.db, tenantId)
  }

  private preview(row: ImportJobRow, read: TableRead): api.ImportPreview {
    return {
      import_job_id: row.id,
      format: row.sourceFormat,
      file_name: row.fileName,
      columns: read.columns,
      mapping: read.mapping,
      cases: read.cases,
      errors: read.errors,
    }
  }

  /** The cases of a job's file under its mapping. */
  private async read(row: ImportJobRow, mapping?: ImportMapping | null): Promise<TableRead> {
    const bytes = await this.options.artifacts.getBytes(
      importSourceKey(row.tenantId, row.id, row.sourceFormat),
    )
    if (!bytes) throw new HttpError(409, 'conflict', 'the uploaded file is gone')
    return readImport(row.sourceFormat, row.fileName, bytes, {
      sheet: row.sheet ?? undefined,
      mapping: mapping === undefined ? (row.mapping as ImportMapping | null) : mapping,
    })
  }

  /** POST /projects/:id/imports: the file read into a preview, kept for `start`. */
  async create(
    caller: Caller,
    projectId: string,
    upload: { fileName: string; bytes: Uint8Array; format?: ImportFormat; sheet?: string },
  ): Promise<api.ImportPreview> {
    await projectsRepo(this.options.db, caller.tenantId, this.options.store).get(projectId)
    if (upload.bytes.length > MAX_IMPORT_BYTES) {
      throw new HttpError(413, 'payload_too_large', 'an import file holds at most 5 MB')
    }
    const format = upload.format ?? formatOf(upload.fileName)
    if (!format) {
      throw new HttpError(
        400,
        'validation_failed',
        'send a .csv, .xlsx or .feature file, or say its format',
      )
    }
    const read = await readImport(format, upload.fileName, upload.bytes, { sheet: upload.sheet })
    const repo = this.repo(caller.tenantId)
    const row = await repo.createJob({
      projectId,
      createdBy: caller.userId,
      sourceFormat: format,
      fileName: upload.fileName,
      sheet: upload.sheet ?? null,
      mapping: read.mapping,
    })
    try {
      await this.options.artifacts.putBytes(
        importSourceKey(caller.tenantId, row.id, format),
        upload.bytes,
        CONTENT_TYPES[format],
      )
    } catch (error) {
      await repo.deletePreview(row.id)
      throw error
    }
    return this.preview(row, read)
  }

  private async inPreview(tenantId: string, id: string): Promise<ImportJobRow> {
    const row = await this.repo(tenantId).getJob(id)
    if (row.status !== 'preview') {
      throw new HttpError(409, 'conflict', `the import is ${row.status}, no longer in preview`)
    }
    return row
  }

  /** PATCH /imports/:id: the file read again under the mapping the person chose. */
  async remap(tenantId: string, id: string, mapping: ImportMapping): Promise<api.ImportPreview> {
    const row = await this.inPreview(tenantId, id)
    if (row.sourceFormat === 'gherkin') {
      throw new HttpError(400, 'validation_failed', 'a Gherkin file has no columns to map')
    }
    const read = await this.read(row, mapping)
    await this.repo(tenantId).updateJob(id, { mapping }, ['preview'])
    return this.preview({ ...row, mapping }, read)
  }

  /**
   * POST /imports/:id/start: the cases go into the repo as one commit (`imports/<id>/*.yaml`),
   * one item each, and the job starts on the device. 400 `no_cases`; 409 like an exploration.
   */
  async start(
    caller: Caller,
    id: string,
    input: api.StartImport,
    author: GitAuthor,
  ): Promise<api.ImportJob> {
    const { db, store } = this.options
    const repo = this.repo(caller.tenantId)
    const row = await this.inPreview(caller.tenantId, id)
    const projects = projectsRepo(db, caller.tenantId, store)
    const app = await projects.getApp(input.app_id)
    const build = await buildsRepo(db, caller.tenantId).get(input.build_id)
    if (app.projectId !== row.projectId || build.appId !== app.id) {
      throw new HttpError(400, 'validation_failed', 'the app or build is not of this project')
    }
    const agents = agentsRepo(db, caller.tenantId)
    const device = await agents.getDevice(input.device_id)
    if (device.status === 'offline' || !this.options.agents.isOnline(device.agentId)) {
      throw new HttpError(409, 'device_offline', 'the device is offline')
    }
    const lease = (await agents.openLeases()).find((l) => l.deviceId === device.id)
    if (lease) {
      throw new HttpError(409, 'device_busy', 'the device is busy', undefined, {
        activity: activityOf(device, lease),
      })
    }
    const config = await this.options.ai.ready(caller.tenantId)
    const { cases } = await this.read(row)
    if (cases.length === 0) {
      throw new HttpError(400, 'no_cases', 'the file has no test case that can be imported')
    }

    const items = cases.map((manual, i) => ({
      n: i + 1,
      manualPath: manualCasePath(row.id, i + 1, manual.title),
      title: manual.title,
    }))
    const commit = await store.commitFiles(caller.tenantId, row.projectId, {
      files: Object.fromEntries(items.map((item, i) => [item.manualPath, toYaml(cases[i])])),
      author,
      message: `Import ${cases.length} manual test case(s) from ${row.fileName}`,
    })
    const budget: api.ImportBudget = {
      max_cost_usd: config.limits.max_cost_usd_per_import,
      max_minutes: api.DEFAULT_IMPORT_MINUTES,
      ...input.budget,
    }
    const started = await repo.updateJob(
      id,
      {
        appId: app.id,
        buildId: build.id,
        deviceId: device.id,
        status: 'running',
        budget,
        manualCommit: commit,
        stats: { ...api.EMPTY_IMPORT_STATS, total: cases.length },
        startedAt: new Date(),
      },
      ['preview'],
    )
    if (!started) throw new HttpError(409, 'conflict', 'the import was started meanwhile')
    await repo.addItems(id, items)
    const job = await repo.getJob(id)
    this.updated(job)
    this.kick(caller.tenantId, id)
    return jobView(job)
  }

  /** POST /imports/:id/cancel: the cases not done yet become `not_processed`. */
  async cancel(tenantId: string, id: string): Promise<api.ImportJob> {
    const repo = this.repo(tenantId)
    const row = await repo.getJob(id)
    if (row.status !== 'running') {
      throw new HttpError(409, 'conflict', `the import is ${row.status}, not running`)
    }
    // A case being worked on ends first (its exploration is stopped), then the job.
    if (this.running.has(id)) {
      this.cancelling.add(id)
      const current = (await repo.items(id)).find((i) => i.status === 'running')
      if (current?.explorationId) await this.stopExploration(tenantId, current.explorationId)
    } else await this.finish(row, 'cancelled')
    return jobView(await repo.getJob(id))
  }

  /** DELETE /imports/:id: a job still in preview, with its file. */
  async remove(tenantId: string, id: string): Promise<void> {
    const row = await this.inPreview(tenantId, id)
    if (!(await this.repo(tenantId).deletePreview(id))) {
      throw new HttpError(409, 'conflict', 'the import was started meanwhile')
    }
    await this.options.artifacts
      .remove(importSourceKey(tenantId, id, row.sourceFormat))
      .catch((error: unknown) =>
        this.options.log?.warn({ err: error, import: id }, 'cannot remove the import file'),
      )
  }

  async list(tenantId: string, projectId: string): Promise<api.ImportJob[]> {
    await projectsRepo(this.options.db, tenantId, this.options.store).get(projectId)
    return (await this.repo(tenantId).listJobs(projectId)).map(jobView)
  }

  /** GET /imports/:id: the job, its cases and, once it ended, its report. */
  async detail(tenantId: string, id: string): Promise<api.ImportJobDetail> {
    const repo = this.repo(tenantId)
    const row = await repo.getJob(id)
    const items = await repo.items(id)
    const views = await Promise.all(
      items.map(async (item) => {
        const step = item.evidence?.step_n
        if (step === undefined || !item.explorationId) return itemView(item)
        const key = explorationStepKey(tenantId, item.explorationId, step, 'screen.jpg')
        return itemView(item, (await this.options.artifacts.presignGet(key)).url)
      }),
    )
    return { ...jobView(row), items: views, report: row.report }
  }

  /**
   * After a restart (research R14): every running job goes on from its first pending case; the
   * case it was on starts over (its exploration was interrupted by the Explorer's recovery).
   */
  async resume(): Promise<number> {
    const jobs = await runningImportJobs(this.options.db)
    for (const { id, tenantId } of jobs) {
      if (this.running.has(id)) continue
      await this.repo(tenantId).requeueRunning(id)
      this.kick(tenantId, id)
    }
    return jobs.length
  }

  /** Shutting down: the runs stop after the case they are on, the jobs stay `running`. */
  close(): void {
    this.closed = true
  }

  /** Works through a running job in the background, once per process. */
  private kick(tenantId: string, id: string): void {
    if (this.running.has(id) || this.closed) return
    this.running.add(id)
    void this.work(tenantId, id)
      .catch(async (error: unknown) => {
        const stop = error instanceof JobStop ? error : undefined
        if (!stop) this.options.log?.error({ err: error, import: id }, 'import job failed')
        else this.options.log?.warn({ import: id, reason: stop.message }, 'import job stopped')
        const row = await this.repo(tenantId).getJob(id)
        await this.finish(row, stop?.status ?? 'failed')
      })
      .catch((error: unknown) =>
        this.options.log?.error({ err: error, import: id }, 'cannot end the import job'),
      )
      .finally(() => {
        this.running.delete(id)
        this.cancelling.delete(id)
      })
  }

  /** One case after the other, each within what is left of the job's budget. */
  private async work(tenantId: string, id: string): Promise<void> {
    const repo = this.repo(tenantId)
    for (;;) {
      if (this.closed) return
      const job = await repo.getJob(id)
      if (job.status !== 'running') return
      if (this.cancelling.has(id)) return this.finish(job, 'cancelled')
      const items = await repo.items(id)
      const pending = items.filter((i) => i.status === 'pending')
      const next = pending[0]
      if (!next) return this.finish(job, 'done')
      const budget = job.budget ?? {
        max_cost_usd: api.DEFAULT_IMPORT_MINUTES,
        max_minutes: api.DEFAULT_IMPORT_MINUTES,
      }
      const spent = items.reduce((sum, i) => sum + i.costUsd, 0)
      const deadline = (job.startedAt ?? job.createdAt).getTime() + budget.max_minutes * 60_000
      const leftUsd = budget.max_cost_usd - spent
      const leftMinutes = (deadline - Date.now()) / 60_000
      // Out of budget: what is left is not processed (data-model §2).
      if (leftUsd <= 0 || leftMinutes <= 0) return this.finish(job, 'cancelled')
      await this.runItem(job, next, {
        max_steps: MAX_IMPORT_STEPS,
        max_cost_usd: leftUsd / pending.length,
        max_minutes: Math.max(
          1,
          Math.min(MAX_CASE_MINUTES, Math.floor(leftMinutes / pending.length)),
        ),
        deadline,
      })
    }
  }

  /** One case: its guided exploration, the Test writer and validation, then its result. */
  private async runItem(
    job: ImportJobRow,
    item: ImportItemRow,
    budget: { max_steps: number; max_cost_usd: number; max_minutes: number; deadline: number },
  ): Promise<void> {
    const repo = this.repo(job.tenantId)
    await repo.updateItem(job.id, item.n, { status: 'running' })
    this.updated(await repo.getJob(job.id), { ...item, status: 'running' })
    const manual = await this.manualCase(job, item)
    const exploration = await this.startExploration(job, item, manual, budget)
    if (!exploration) {
      await repo.updateItem(job.id, item.n, { status: 'pending' })
      return
    }
    await repo.updateItem(job.id, item.n, { explorationId: exploration.id })
    const ended = await this.waitFor(job, exploration.id)
    const result = await this.resultOf(job, item, ended)
    await repo.updateItem(job.id, item.n, result)
    const items = await repo.items(job.id)
    const stats = statsOf(
      items,
      items.reduce((sum, i) => sum + i.costUsd, 0),
    )
    await repo.updateJob(job.id, { stats }, ['running'])
    const done = items.find((i) => i.n === item.n)
    this.updated(await repo.getJob(job.id), done)
  }

  /** The manual case of an item, as committed; secret values are named before the AI sees it. */
  private async manualCase(job: ImportJobRow, item: ImportItemRow): Promise<ManualCase> {
    const yaml = await this.options.store.readFile(job.tenantId, job.projectId, item.manualPath)
    const parsed = manualCaseSchema.safeParse(yaml === null ? undefined : parseYaml(yaml).value)
    if (!parsed.success) throw new Error(`${item.manualPath} is not a manual case`)
    return referenceSecrets(parsed.data, this.options.ai.secretValues())
  }

  /** Starts the case's exploration, waiting while the device is busy or offline. */
  private async startExploration(
    job: ImportJobRow,
    item: ImportItemRow,
    manual: ManualCase,
    budget: { max_steps: number; max_cost_usd: number; max_minutes: number; deadline: number },
  ): Promise<api.Exploration | undefined> {
    const retryMs = this.options.retryMs ?? 5000
    for (;;) {
      if (this.cancelling.has(job.id) || this.closed) return undefined
      try {
        return await this.options.explorations.start(
          { tenantId: job.tenantId, userId: job.createdBy },
          {
            project_id: job.projectId,
            app_id: job.appId ?? '',
            build_id: job.buildId ?? '',
            device_id: job.deviceId ?? '',
            goal: goalOf(manual),
            budget: {
              max_steps: budget.max_steps,
              max_cost_usd: budget.max_cost_usd,
              max_minutes: budget.max_minutes,
            },
            max_tests: 1,
          },
          { kind: 'import', importItemId: item.id },
        )
      } catch (error) {
        if (!(error instanceof HttpError)) throw error
        if (error.code === 'daily_limit_reached') throw new JobStop('cancelled', error.message)
        if (!WAIT_FOR.has(error.code)) throw new JobStop('failed', error.message)
        if (Date.now() + retryMs > budget.deadline) return undefined
        await sleep(retryMs)
      }
    }
  }

  /** The exploration once it ended (written and validated); stopped when the job is cancelled. */
  private async waitFor(job: ImportJobRow, explorationId: string): Promise<ExplorationRow> {
    const repo = explorationsRepo(this.options.db, job.tenantId)
    let stopped = false
    for (;;) {
      const row = await repo.get(explorationId)
      if (ENDED.has(row.status)) return row
      if (this.cancelling.has(job.id) && !stopped) {
        stopped = true
        await this.stopExploration(job.tenantId, explorationId)
      }
      await sleep(this.options.pollMs ?? 1000)
    }
  }

  private async stopExploration(tenantId: string, id: string): Promise<void> {
    await this.options.explorations.stop(tenantId, id).catch((error: unknown) => {
      // Already past exploring (writing, validating): it ends by itself.
      if (!(error instanceof HttpError)) throw error
    })
  }

  /**
   * What became of a case (research R14): `active`, or `draft` with why — the writer's outcome
   * and the step that shows it, a failed validation, a duplicate, or what stopped it.
   */
  private async resultOf(
    job: ImportJobRow,
    item: ImportItemRow,
    exploration: ExplorationRow,
  ): Promise<ImportItemPatch> {
    const { db, store } = this.options
    const testCases = testCasesRepo(db, job.tenantId, store, projectsRepo(db, job.tenantId, store))
    const [written] = await testCases.list(job.projectId, { sourceRef: `import_item:${item.id}` })
    const report = exploration.writerReport
    const costUsd = exploration.stats.cost_usd
    const draft = (
      reason: api.ImportItemReason,
      message: string,
      extra: Partial<ImportItemPatch> = {},
    ): ImportItemPatch => ({ status: 'draft', reason, evidence: { message }, costUsd, ...extra })
    if (written) {
      if (written.status === 'active') {
        return { status: 'active', reason: null, evidence: null, testCaseId: written.id, costUsd }
      }
      const failed =
        written.draftReason === 'validation_failed' ||
        written.draftReason === 'changed_during_validation'
      return draft(
        failed ? 'validation_failed' : 'needs_human',
        failed
          ? 'the test case did not pass its validation runs'
          : written.flags.includes('needs_review_never_tap')
            ? 'the test case taps a never_tap button: a person reviews it'
            : 'the test case waits for a person',
        { testCaseId: written.id },
      )
    }
    if (report?.outcome && report.outcome !== 'written') {
      return {
        status: 'draft',
        reason: report.outcome,
        evidence: {
          ...(report.evidence_step !== undefined ? { step_n: report.evidence_step } : {}),
          message: report.explanation ?? report.outcome.replace('_', ' '),
        },
        costUsd,
      }
    }
    const duplicate = report?.skipped.find((s) => s.reason === 'duplicate')
    if (duplicate?.duplicate_of) {
      const same = (await testCases.list(job.projectId)).find(
        (t) => t.slug === duplicate.duplicate_of,
      )
      return draft('duplicate', `the same steps as test case ${duplicate.duplicate_of}`, {
        ...(same ? { testCaseId: same.id } : {}),
      })
    }
    const why =
      exploration.status === 'failed' || exploration.status === 'interrupted'
        ? `the exploration ${exploration.status} (${exploration.stopReason ?? 'error'})`
        : report?.error
          ? `the Test writer gave no test case (${report.error})`
          : (report?.skipped[0]?.message ?? 'no test case could be written from the trace')
    return draft('needs_human', why)
  }

  /** Ends a job: what is left becomes `not_processed`, the report is written, the file goes. */
  private async finish(row: ImportJobRow, status: 'done' | 'cancelled' | 'failed') {
    const repo = this.repo(row.tenantId)
    await repo.requeueRunning(row.id)
    await repo.markNotProcessed(row.id)
    const items = await repo.items(row.id)
    const report = reportOf(items)
    const ended = await repo.updateJob(
      row.id,
      { status, report, stats: statsOf(items, report.cost_usd), finishedAt: new Date() },
      ['running'],
    )
    if (!ended) return
    await this.options.artifacts
      .remove(importSourceKey(row.tenantId, row.id, row.sourceFormat))
      .catch((error: unknown) =>
        this.options.log?.warn({ err: error, import: row.id }, 'cannot remove the import file'),
      )
    this.updated(await repo.getJob(row.id))
  }

  private updated(row: ImportJobRow, item?: ImportItemRow): void {
    this.options.events?.emit(row.tenantId, {
      import_job_id: row.id,
      status: row.status,
      stats: row.stats,
      ...(item
        ? {
            item: {
              n: item.n,
              status: item.status,
              ...(item.reason ? { reason: item.reason } : {}),
            },
          }
        : {}),
    })
  }
}

/** Progress counted from the items. */
export function statsOf(items: readonly ImportItemRow[], costUsd: number): api.ImportStats {
  const count = (status: ImportItemRow['status']) => items.filter((i) => i.status === status).length
  return {
    total: items.length,
    done: items.filter((i) => ['active', 'draft', 'not_processed'].includes(i.status)).length,
    active: count('active'),
    draft: count('draft'),
    not_processed: count('not_processed'),
    cost_usd: costUsd,
  }
}

/** `import_jobs.report` (data-model §3). */
export function reportOf(items: readonly ImportItemRow[]): api.ImportReport {
  const draft = Object.fromEntries(
    api.IMPORT_ITEM_REASONS.map((reason) => [
      reason,
      items.filter((i) => i.status === 'draft' && i.reason === reason).length,
    ]),
  ) as api.ImportReport['draft']
  return {
    total: items.length,
    active: items.filter((i) => i.status === 'active').length,
    draft,
    not_processed: items.filter((i) => i.status === 'not_processed').length,
    cost_usd: items.reduce((sum, i) => sum + i.costUsd, 0),
    items: items.map((i) => ({
      n: i.n,
      title: i.title,
      status: i.status,
      ...(i.testCaseId ? { test_case_id: i.testCaseId } : {}),
    })),
  }
}
