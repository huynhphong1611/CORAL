import type { FailureCode } from '@coral/shared'
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { apps, builds, devices, leases, runItems, runs, runSteps, testCases } from '../db/schema'
import { isUniqueViolation } from './pg-errors'
import type { RunItemRow, RunRow } from './runs'

type LeaseReason = NonNullable<(typeof leases.$inferSelect)['releaseReason']>
type ItemStatus = RunItemRow['status']
type FinalRunStatus = Extract<RunRow['status'], 'passed' | 'failed' | 'cancelled' | 'error'>

export const runHolder = (runId: string) => `run:${runId}`

/**
 * State changes driven by the dispatcher, the agent channel and the sweepers. Not tenant-scoped
 * by itself: callers check that the agent that sent a message owns the run (P5).
 * Every transition is guarded by the current status, so late or duplicate messages are no-ops.
 */
export function runControl(db: Db) {
  return {
    async getRun(runId: string): Promise<RunRow | undefined> {
      const [row] = await db.select().from(runs).where(eq(runs.id, runId))
      return row
    },

    /** Everything the dispatcher needs to assign a run. */
    async assignment(runId: string) {
      const [row] = await db
        .select({ run: runs, device: devices, build: builds, app: apps })
        .from(runs)
        .innerJoin(devices, eq(devices.id, runs.deviceId))
        .innerJoin(builds, eq(builds.id, runs.buildId))
        .innerJoin(apps, eq(apps.id, builds.appId))
        .where(eq(runs.id, runId))
      return row
    },

    items(runId: string): Promise<RunItemRow[]> {
      return db.select().from(runItems).where(eq(runItems.runId, runId)).orderBy(runItems.position)
    },

    /** Items with the path of their test case in the project repo (for job.assign). */
    itemsWithPaths(runId: string) {
      return db
        .select({ item: runItems, pathInRepo: testCases.pathInRepo })
        .from(runItems)
        .innerJoin(testCases, eq(testCases.id, runItems.testCaseId))
        .where(eq(runItems.runId, runId))
        .orderBy(runItems.position)
    },

    async item(itemId: string): Promise<RunItemRow | undefined> {
      const [row] = await db.select().from(runItems).where(eq(runItems.id, itemId))
      return row
    },

    /** Inserts the lease; undefined when the device already has an open one (partial unique index). */
    async acquireLease(input: {
      tenantId: string
      deviceId: string
      holderRef: string
      ttlMs: number
    }): Promise<string | undefined> {
      try {
        return await db.transaction(async (tx) => {
          const [lease] = await tx
            .insert(leases)
            .values({
              tenantId: input.tenantId,
              deviceId: input.deviceId,
              kind: 'run',
              holderRef: input.holderRef,
              expiresAt: new Date(Date.now() + input.ttlMs),
            })
            .returning({ id: leases.id })
          await tx
            .update(devices)
            .set({ status: 'leased' })
            .where(and(eq(devices.id, input.deviceId), eq(devices.status, 'idle')))
          return lease?.id
        })
      } catch (error) {
        if (isUniqueViolation(error, 'leases_one_open_per_device')) return undefined
        throw error
      }
    },

    /** Releases the holder's open lease; the device goes back to idle unless it is offline. */
    async releaseLease(holderRef: string, reason: LeaseReason): Promise<boolean> {
      return db.transaction(async (tx) => {
        const released = await tx
          .update(leases)
          .set({ releasedAt: new Date(), releaseReason: reason })
          .where(and(eq(leases.holderRef, holderRef), isNull(leases.releasedAt)))
          .returning({ deviceId: leases.deviceId })
        const deviceIds = released.map((l) => l.deviceId)
        if (deviceIds.length > 0) {
          await tx
            .update(devices)
            .set({ status: 'idle' })
            .where(and(inArray(devices.id, deviceIds), eq(devices.status, 'leased')))
        }
        return released.length > 0
      })
    },

    expiredLeases(now: Date) {
      return db
        .select()
        .from(leases)
        .where(and(isNull(leases.releasedAt), lt(leases.expiresAt, now)))
    },

    async markRunning(runId: string, now: Date): Promise<boolean> {
      const rows = await db
        .update(runs)
        .set({ status: 'running', startedAt: now })
        .where(and(eq(runs.id, runId), eq(runs.status, 'queued')))
        .returning({ id: runs.id })
      return rows.length > 0
    },

    /**
     * Ends a queued or running run. Items still running end as `error` with `itemCode`; items
     * that never started are `skipped`. Returns false when the run had already ended.
     */
    async finishRun(
      runId: string,
      status: FinalRunStatus,
      failureCode: FailureCode | null,
      itemCode?: FailureCode,
    ): Promise<boolean> {
      return db.transaction(async (tx) => {
        const now = new Date()
        const ended = await tx
          .update(runs)
          .set({ status, failureCode, finishedAt: now })
          .where(and(eq(runs.id, runId), inArray(runs.status, ['queued', 'running'])))
          .returning({ id: runs.id })
        if (ended.length === 0) return false
        await tx
          .update(runItems)
          .set({
            status: 'error',
            failureCode: itemCode ?? failureCode,
            finishedAt: now,
          })
          .where(and(eq(runItems.runId, runId), eq(runItems.status, 'running')))
        await tx
          .update(runItems)
          .set({ status: 'skipped', finishedAt: now })
          .where(and(eq(runItems.runId, runId), eq(runItems.status, 'pending')))
        return true
      })
    },

    async startItem(itemId: string, runId: string): Promise<void> {
      await db
        .update(runItems)
        .set({ status: 'running', startedAt: new Date() })
        .where(
          and(eq(runItems.id, itemId), eq(runItems.runId, runId), eq(runItems.status, 'pending')),
        )
    },

    async finishItem(input: {
      itemId: string
      runId: string
      status: Extract<ItemStatus, 'passed' | 'failed' | 'error'>
      failureCode: FailureCode | null
      failedStepId: string | null
      startedAt: Date
      finishedAt: Date
    }): Promise<void> {
      await db
        .update(runItems)
        .set({
          status: input.status,
          failureCode: input.failureCode,
          failedStepId: input.failedStepId,
          startedAt: input.startedAt,
          finishedAt: input.finishedAt,
        })
        .where(
          and(
            eq(runItems.id, input.itemId),
            eq(runItems.runId, input.runId),
            inArray(runItems.status, ['pending', 'running']),
          ),
        )
    },

    /** Stores one step result; a duplicate (run_item_id, step_index) is ignored. */
    async addStep(step: typeof runSteps.$inferInsert): Promise<boolean> {
      const rows = await db
        .insert(runSteps)
        .values(step)
        .onConflictDoNothing({ target: [runSteps.runItemId, runSteps.stepIndex] })
        .returning({ id: runSteps.id })
      return rows.length > 0
    },

    /** Runs currently on devices of this agent (for DEVICE_OFFLINE). */
    activeRunsOnAgent(agentId: string) {
      return db
        .select({ run: runs })
        .from(runs)
        .innerJoin(devices, eq(devices.id, runs.deviceId))
        .where(and(eq(devices.agentId, agentId), inArray(runs.status, ['queued', 'running'])))
    },

    /** Status of all items, to compute the final run status. */
    async itemCounts(runId: string) {
      return db
        .select({ status: runItems.status, count: sql<number>`count(*)::int` })
        .from(runItems)
        .where(eq(runItems.runId, runId))
        .groupBy(runItems.status)
    },
  }
}

export type RunControl = ReturnType<typeof runControl>
