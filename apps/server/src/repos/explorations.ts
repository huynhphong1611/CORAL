import { newId, type api } from '@coral/shared'
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { devices, explorationSteps, explorations, findings, leases, users } from '../db/schema'
import { notFound } from '../http/errors'
import { isUniqueViolation } from './pg-errors'

export const explorationHolder = (explorationId: string) => `exploration:${explorationId}`

type Exploration = typeof explorations.$inferSelect
export type ExplorationRow = Exploration & { userName: string }
export type ExplorationStepRow = typeof explorationSteps.$inferSelect
export type FindingRow = typeof findings.$inferSelect
type Status = Exploration['status']

/** What changes while an exploration runs; everything else is fixed at creation. */
export type ExplorationPatch = Partial<
  Pick<
    Exploration,
    | 'status'
    | 'stopReason'
    | 'stats'
    | 'screens'
    | 'startedAt'
    | 'finishedAt'
    | 'appmapCommit'
    | 'leaseId'
  >
>

export interface NewExplorationStep {
  n: number
  segment: number
  fingerprint: string
  screenId?: string | null
  decision?: api.ExplorationStepView['decision']
  status: ExplorationStepRow['status']
  refusal?: ExplorationStepRow['refusal']
  step?: unknown
  suggestions?: unknown[]
  flags?: api.StepFlag[]
  artifactPrefix?: string | null
  brainCallId?: string | null
  costUsd?: number
}

/**
 * Explorations, their trace and findings (data-model §1–2). An exploration holds its device with
 * a lease of kind `exploration` from creation; the caller releases it (runControl) before writing
 * test cases. Tenant-scoped (P5).
 */
export function explorationsRepo(db: Db, tenantId: string) {
  const mine = (id: string) => and(eq(explorations.tenantId, tenantId), eq(explorations.id, id))
  const select = () =>
    db
      .select({ exploration: explorations, userName: users.name })
      .from(explorations)
      .innerJoin(users, eq(users.id, explorations.userId))
  const toRow = (r: { exploration: Exploration; userName: string }): ExplorationRow => ({
    ...r.exploration,
    userName: r.userName,
  })

  return {
    /** A new exploration holding the device; undefined when the device has an open lease. */
    async create(input: {
      projectId: string
      appId: string
      buildId: string
      deviceId: string
      userId: string
      kind: Exploration['kind']
      goal?: string | null
      budget: api.ExplorationBudget
      maxTests: number
      importItemId?: string | null
      leaseTtlMs: number
    }): Promise<ExplorationRow | undefined> {
      const id = newId()
      try {
        await db.transaction(async (tx) => {
          const [lease] = await tx
            .insert(leases)
            .values({
              tenantId,
              deviceId: input.deviceId,
              kind: 'exploration',
              holderRef: explorationHolder(id),
              expiresAt: new Date(Date.now() + input.leaseTtlMs),
            })
            .returning({ id: leases.id })
          if (!lease) throw new Error('lease not stored')
          await tx
            .update(devices)
            .set({ status: 'leased' })
            .where(and(eq(devices.id, input.deviceId), eq(devices.status, 'idle')))
          await tx.insert(explorations).values({
            id,
            tenantId,
            projectId: input.projectId,
            appId: input.appId,
            buildId: input.buildId,
            deviceId: input.deviceId,
            userId: input.userId,
            leaseId: lease.id,
            kind: input.kind,
            goal: input.goal ?? null,
            budget: input.budget,
            maxTests: input.maxTests,
            importItemId: input.importItemId ?? null,
          })
        })
      } catch (error) {
        if (isUniqueViolation(error, 'leases_one_open_per_device')) return undefined
        throw error
      }
      return this.get(id)
    },

    async get(id: string): Promise<ExplorationRow> {
      const [row] = await select().where(mine(id))
      if (!row) throw notFound('exploration')
      return toRow(row)
    },

    async list(filter: { projectId?: string; status?: Status } = {}): Promise<ExplorationRow[]> {
      const rows = await select()
        .where(
          and(
            eq(explorations.tenantId, tenantId),
            filter.projectId ? eq(explorations.projectId, filter.projectId) : undefined,
            filter.status ? eq(explorations.status, filter.status) : undefined,
          ),
        )
        .orderBy(desc(explorations.createdAt))
        .limit(100)
      return rows.map(toRow)
    },

    /** Applies `patch`; with `from`, only while the status is one of them (false otherwise). */
    async update(id: string, patch: ExplorationPatch, from?: readonly Status[]): Promise<boolean> {
      const rows = await db
        .update(explorations)
        .set(patch)
        .where(and(mine(id), from ? inStatuses(from) : undefined))
        .returning({ id: explorations.id })
      return rows.length > 0
    },

    /** Keeps the device: the lease of a running exploration is pushed back after every step. */
    async touchLease(id: string, ttlMs: number): Promise<void> {
      await db
        .update(leases)
        .set({ expiresAt: new Date(Date.now() + ttlMs) })
        .where(
          and(
            eq(leases.tenantId, tenantId),
            eq(leases.holderRef, explorationHolder(id)),
            isNull(leases.releasedAt),
          ),
        )
    },

    /** Explorations of this tenant still holding a device or writing (`CORAL_MAX_EXPLORATIONS`). */
    async countActive(): Promise<number> {
      const rows = await db
        .select({ id: explorations.id })
        .from(explorations)
        .where(and(eq(explorations.tenantId, tenantId), inStatuses(ACTIVE)))
      return rows.length
    },

    /** A trace step; its number is unique within the exploration. */
    async addStep(explorationId: string, step: NewExplorationStep): Promise<ExplorationStepRow> {
      await this.get(explorationId)
      const [row] = await db
        .insert(explorationSteps)
        .values({
          tenantId,
          explorationId,
          n: step.n,
          segment: step.segment,
          fingerprint: step.fingerprint,
          screenId: step.screenId ?? null,
          decision: step.decision ?? null,
          status: step.status,
          refusal: step.refusal ?? null,
          step: step.step ?? null,
          suggestions: step.suggestions ?? [],
          flags: step.flags ?? [],
          artifactPrefix: step.artifactPrefix ?? null,
          brainCallId: step.brainCallId ?? null,
          costUsd: step.costUsd ?? 0,
        })
        .returning()
      if (!row) throw new Error('step not stored')
      return row
    },

    /** Names every step taken on a screen once the app map gives it an id. */
    async setStepScreen(explorationId: string, fingerprint: string, screenId: string) {
      await db
        .update(explorationSteps)
        .set({ screenId })
        .where(
          and(
            eq(explorationSteps.tenantId, tenantId),
            eq(explorationSteps.explorationId, explorationId),
            eq(explorationSteps.fingerprint, fingerprint),
          ),
        )
    },

    /** Steps after number `after`, in order (`GET /explorations/:id/steps`). */
    async steps(
      explorationId: string,
      page: { after?: number; limit?: number } = {},
    ): Promise<ExplorationStepRow[]> {
      return db
        .select()
        .from(explorationSteps)
        .where(
          and(
            eq(explorationSteps.tenantId, tenantId),
            eq(explorationSteps.explorationId, explorationId),
            gt(explorationSteps.n, page.after ?? 0),
          ),
        )
        .orderBy(asc(explorationSteps.n))
        .limit(page.limit ?? 1000)
    },

    async addFinding(input: {
      explorationId: string
      stepN: number
      kind: FindingRow['kind']
      logExcerpt: string
      artifactPrefix?: string | null
    }): Promise<FindingRow> {
      const exploration = await this.get(input.explorationId)
      const [row] = await db
        .insert(findings)
        .values({
          tenantId,
          projectId: exploration.projectId,
          explorationId: input.explorationId,
          stepN: input.stepN,
          kind: input.kind,
          logExcerpt: input.logExcerpt,
          artifactPrefix: input.artifactPrefix ?? null,
        })
        .returning()
      if (!row) throw new Error('finding not stored')
      return row
    },

    findings(explorationId: string): Promise<FindingRow[]> {
      return db
        .select()
        .from(findings)
        .where(and(eq(findings.tenantId, tenantId), eq(findings.explorationId, explorationId)))
        .orderBy(asc(findings.stepN))
    },
  }
}

/** An exploration in these is running or about to: it counts against the tenant's limit. */
const ACTIVE = ['queued', 'running', 'writing'] as const satisfies readonly Status[]

/** Explorations a server restart cut off, every tenant unless one is given (research R9). */
export function interruptedExplorations(db: Db, tenantId?: string) {
  return db
    .select({ id: explorations.id, tenantId: explorations.tenantId })
    .from(explorations)
    .where(and(inStatuses(ACTIVE), tenantId ? eq(explorations.tenantId, tenantId) : undefined))
}

/** Explorations whose validation runs a restart left without anyone waiting for them. */
export function validatingExplorations(db: Db, tenantId?: string) {
  return db
    .select({ id: explorations.id, tenantId: explorations.tenantId })
    .from(explorations)
    .where(
      and(
        eq(explorations.status, 'validating'),
        tenantId ? eq(explorations.tenantId, tenantId) : undefined,
      ),
    )
}

/** Running explorations on the devices of an agent that went away. */
export function explorationsOnAgent(db: Db, agentId: string) {
  return db
    .select({ id: explorations.id, tenantId: explorations.tenantId })
    .from(explorations)
    .innerJoin(devices, eq(devices.id, explorations.deviceId))
    .where(and(eq(devices.agentId, agentId), eq(explorations.status, 'running')))
}

function inStatuses(statuses: readonly Status[]) {
  return inArray(explorations.status, [...statuses])
}

export type ExplorationsRepo = ReturnType<typeof explorationsRepo>
