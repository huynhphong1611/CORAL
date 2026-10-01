import {
  api,
  manualCasePath,
  MAX_IMPORT_BYTES,
  toYaml,
  type ImportFormat,
  type ImportMapping,
  type protocol,
} from '@coral/shared'
import type { FastifyBaseLogger } from 'fastify'
import type { AgentGateway } from '../agents/gateway'
import type { AiService } from '../ai/service'
import type { Db } from '../db/client'
import { activityOf } from '../devices/views'
import type { GitAuthor, ProjectRepoStore } from '../git/project-repo-store'
import { HttpError } from '../http/errors'
import type { Caller } from '../live/control'
import { agentsRepo } from '../repos/agents'
import { buildsRepo } from '../repos/builds'
import { importsRepo, type ImportItemRow, type ImportJobRow } from '../repos/imports'
import { projectsRepo } from '../repos/projects'
import { importSourceKey } from '../storage/keys'
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
  ai: Pick<AiService, 'ready'>
  events?: ImportEvents
  log?: FastifyBaseLogger
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
    return jobView(job)
  }

  /** POST /imports/:id/cancel: the cases not done yet become `not_processed`. */
  async cancel(tenantId: string, id: string): Promise<api.ImportJob> {
    const repo = this.repo(tenantId)
    const row = await repo.getJob(id)
    if (row.status !== 'running') {
      throw new HttpError(409, 'conflict', `the import is ${row.status}, not running`)
    }
    await this.finish(row, 'cancelled')
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
    return { ...jobView(row), items: items.map((item) => itemView(item)), report: row.report }
  }

  /** Ends a job: what is left becomes `not_processed`, the report is written, the file goes. */
  private async finish(row: ImportJobRow, status: 'done' | 'cancelled' | 'failed') {
    const repo = this.repo(row.tenantId)
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
