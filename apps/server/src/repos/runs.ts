import { and, asc, desc, eq, exists, isNotNull, lt } from 'drizzle-orm'
import type { Db } from '../db/client'
import { runItems, runs, runSteps, testCases } from '../db/schema'
import { notFound } from '../http/errors'

export type RunRow = typeof runs.$inferSelect
export type RunItemRow = typeof runItems.$inferSelect
export type RunStepRow = typeof runSteps.$inferSelect

export interface NewRun {
  projectId: string
  buildId: string
  deviceId: string
  popupsCommit: string
  createdBy: string
  items: { testCaseId: string; commit: string }[]
  /** `validation` for the two runs that validate an AI-written test case (research R13). */
  trigger?: RunRow['trigger']
  validationOf?: string | null
}

/** Runs as the operator sees them, scoped to one tenant (P5). */
export function runsRepo(db: Db, tenantId: string) {
  const inTenant = eq(runs.tenantId, tenantId)

  return {
    async create(input: NewRun): Promise<{ run: RunRow; items: RunItemRow[] }> {
      return db.transaction(async (tx) => {
        const [run] = await tx
          .insert(runs)
          .values({
            tenantId,
            projectId: input.projectId,
            buildId: input.buildId,
            deviceId: input.deviceId,
            popupsCommit: input.popupsCommit,
            createdBy: input.createdBy,
            ...(input.trigger ? { trigger: input.trigger } : {}),
            ...(input.validationOf ? { validationOf: input.validationOf } : {}),
          })
          .returning()
        if (!run) throw new Error('run not stored')
        const items = await tx
          .insert(runItems)
          .values(
            input.items.map((item, position) => ({
              tenantId,
              runId: run.id,
              testCaseId: item.testCaseId,
              commit: item.commit,
              position,
            })),
          )
          .returning()
        return { run, items: items.sort((a, b) => a.position - b.position) }
      })
    },

    async get(id: string): Promise<RunRow> {
      const [row] = await db
        .select()
        .from(runs)
        .where(and(inTenant, eq(runs.id, id)))
      if (!row) throw notFound('run')
      return row
    },

    /** Newest first; the cursor is the last run id of the previous page (ids are UUID v7). */
    async list(query: {
      projectId?: string
      status?: RunRow['status']
      deviceId?: string
      testCaseId?: string
      limit: number
      cursor?: string
    }) {
      const rows = await db
        .select()
        .from(runs)
        .where(
          and(
            inTenant,
            query.projectId ? eq(runs.projectId, query.projectId) : undefined,
            query.status ? eq(runs.status, query.status) : undefined,
            query.deviceId ? eq(runs.deviceId, query.deviceId) : undefined,
            query.testCaseId
              ? exists(
                  db
                    .select({ id: runItems.id })
                    .from(runItems)
                    .where(
                      and(
                        eq(runItems.tenantId, tenantId),
                        eq(runItems.runId, runs.id),
                        eq(runItems.testCaseId, query.testCaseId),
                      ),
                    ),
                )
              : undefined,
            query.cursor ? lt(runs.id, query.cursor) : undefined,
          ),
        )
        .orderBy(desc(runs.id))
        .limit(query.limit + 1)
      const page = rows.slice(0, query.limit)
      return {
        rows: page,
        nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
      }
    },

    items(runId: string) {
      return db
        .select({ item: runItems, slug: testCases.slug })
        .from(runItems)
        .innerJoin(testCases, eq(testCases.id, runItems.testCaseId))
        .where(and(eq(runItems.tenantId, tenantId), eq(runItems.runId, runId)))
        .orderBy(asc(runItems.position))
    },

    async steps(runId: string, itemId: string): Promise<RunStepRow[]> {
      const [item] = await db
        .select()
        .from(runItems)
        .where(
          and(eq(runItems.tenantId, tenantId), eq(runItems.runId, runId), eq(runItems.id, itemId)),
        )
      if (!item) throw notFound('run item')
      return db
        .select()
        .from(runSteps)
        .where(and(eq(runSteps.tenantId, tenantId), eq(runSteps.runItemId, itemId)))
        .orderBy(asc(runSteps.stepIndex))
    },

    /** The steps of the latest finished item of a test case that recorded any (FR-019). */
    async lastItemSteps(
      testCaseId: string,
    ): Promise<{ item: RunItemRow; steps: RunStepRow[] } | undefined> {
      const [item] = await db
        .select()
        .from(runItems)
        .where(
          and(
            eq(runItems.tenantId, tenantId),
            eq(runItems.testCaseId, testCaseId),
            isNotNull(runItems.finishedAt),
            exists(
              db
                .select({ id: runSteps.id })
                .from(runSteps)
                .where(and(eq(runSteps.tenantId, tenantId), eq(runSteps.runItemId, runItems.id))),
            ),
          ),
        )
        .orderBy(desc(runItems.finishedAt))
        .limit(1)
      if (!item) return undefined
      const steps = await db
        .select()
        .from(runSteps)
        .where(and(eq(runSteps.tenantId, tenantId), eq(runSteps.runItemId, item.id)))
        .orderBy(asc(runSteps.stepIndex))
      return { item, steps }
    },
  }
}

export type RunsRepo = ReturnType<typeof runsRepo>
