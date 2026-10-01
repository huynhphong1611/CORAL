import { newId } from '@coral/shared'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/client'
import { importItems, importJobs, users } from '../db/schema'
import { notFound } from '../http/errors'

type ImportJob = typeof importJobs.$inferSelect
export type ImportJobRow = ImportJob & { createdByName: string }
export type ImportItemRow = typeof importItems.$inferSelect
type JobStatus = ImportJob['status']

export type ImportJobPatch = Partial<
  Pick<
    ImportJob,
    | 'appId'
    | 'buildId'
    | 'deviceId'
    | 'mapping'
    | 'status'
    | 'budget'
    | 'stats'
    | 'report'
    | 'manualCommit'
    | 'startedAt'
    | 'finishedAt'
  >
>

export type ImportItemPatch = Partial<
  Pick<ImportItemRow, 'status' | 'reason' | 'evidence' | 'explorationId' | 'testCaseId' | 'costUsd'>
>

/**
 * Import jobs of manual test cases and one item per case (data-model §1–2). Items are stored one
 * by one so a job resumes after a restart from its first pending case. Tenant-scoped (P5).
 */
export function importsRepo(db: Db, tenantId: string) {
  const mine = (id: string) => and(eq(importJobs.tenantId, tenantId), eq(importJobs.id, id))
  const select = () =>
    db
      .select({ job: importJobs, createdByName: users.name })
      .from(importJobs)
      .innerJoin(users, eq(users.id, importJobs.createdBy))
  const toRow = (r: { job: ImportJob; createdByName: string }): ImportJobRow => ({
    ...r.job,
    createdByName: r.createdByName,
  })
  const itemOf = (jobId: string, n: number) =>
    and(
      eq(importItems.tenantId, tenantId),
      eq(importItems.importJobId, jobId),
      eq(importItems.n, n),
    )

  return {
    async createJob(input: {
      projectId: string
      createdBy: string
      sourceFormat: ImportJob['sourceFormat']
      fileName: string
      sheet?: string | null
      mapping?: unknown
    }): Promise<ImportJobRow> {
      const id = newId()
      await db.insert(importJobs).values({
        id,
        tenantId,
        projectId: input.projectId,
        createdBy: input.createdBy,
        sourceFormat: input.sourceFormat,
        fileName: input.fileName,
        sheet: input.sheet ?? null,
        mapping: input.mapping ?? null,
      })
      return this.getJob(id)
    },

    async getJob(id: string): Promise<ImportJobRow> {
      const [row] = await select().where(mine(id))
      if (!row) throw notFound('import job')
      return toRow(row)
    },

    async listJobs(projectId: string): Promise<ImportJobRow[]> {
      const rows = await select()
        .where(and(eq(importJobs.tenantId, tenantId), eq(importJobs.projectId, projectId)))
        .orderBy(desc(importJobs.createdAt))
        .limit(100)
      return rows.map(toRow)
    },

    /** Applies `patch`; with `from`, only while the status is one of them (false otherwise). */
    async updateJob(id: string, patch: ImportJobPatch, from?: readonly JobStatus[]) {
      const rows = await db
        .update(importJobs)
        .set(patch)
        .where(and(mine(id), from ? inStatuses(from) : undefined))
        .returning({ id: importJobs.id })
      return rows.length > 0
    },

    /** Deletes a job still in preview (its items go with it); false otherwise. */
    async deletePreview(id: string): Promise<boolean> {
      const rows = await db
        .delete(importJobs)
        .where(and(mine(id), eq(importJobs.status, 'preview')))
        .returning({ id: importJobs.id })
      return rows.length > 0
    },

    async addItems(
      jobId: string,
      items: readonly { n: number; manualPath: string; title: string }[],
    ): Promise<void> {
      await this.getJob(jobId)
      if (items.length === 0) return
      await db
        .insert(importItems)
        .values(items.map((item) => ({ ...item, tenantId, importJobId: jobId })))
    },

    items(jobId: string): Promise<ImportItemRow[]> {
      return db
        .select()
        .from(importItems)
        .where(and(eq(importItems.tenantId, tenantId), eq(importItems.importJobId, jobId)))
        .orderBy(asc(importItems.n))
    },

    async updateItem(jobId: string, n: number, patch: ImportItemPatch): Promise<void> {
      await db
        .update(importItems)
        .set({ ...patch, updatedAt: new Date() })
        .where(itemOf(jobId, n))
    },

    /** The first case still to do, if any. */
    async nextPending(jobId: string): Promise<ImportItemRow | undefined> {
      const [row] = await db
        .select()
        .from(importItems)
        .where(
          and(
            eq(importItems.tenantId, tenantId),
            eq(importItems.importJobId, jobId),
            eq(importItems.status, 'pending'),
          ),
        )
        .orderBy(asc(importItems.n))
        .limit(1)
      return row
    },

    /** After a restart: a case that was running starts over (data-model §2). */
    async requeueRunning(jobId: string): Promise<number> {
      const rows = await db
        .update(importItems)
        .set({ status: 'pending', explorationId: null, updatedAt: new Date() })
        .where(
          and(
            eq(importItems.tenantId, tenantId),
            eq(importItems.importJobId, jobId),
            eq(importItems.status, 'running'),
          ),
        )
        .returning({ n: importItems.n })
      return rows.length
    },

    /** Cancel or budget exhausted: every case not done yet becomes `not_processed`. */
    async markNotProcessed(jobId: string): Promise<number> {
      const rows = await db
        .update(importItems)
        .set({ status: 'not_processed', updatedAt: new Date() })
        .where(
          and(
            eq(importItems.tenantId, tenantId),
            eq(importItems.importJobId, jobId),
            eq(importItems.status, 'pending'),
          ),
        )
        .returning({ n: importItems.n })
      return rows.length
    },
  }
}

function inStatuses(statuses: readonly JobStatus[]) {
  return inArray(importJobs.status, [...statuses])
}

export type ImportsRepo = ReturnType<typeof importsRepo>
