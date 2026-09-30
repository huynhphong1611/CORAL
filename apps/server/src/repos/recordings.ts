import { newId, type RecordingStep } from '@coral/shared'
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm'
import type { Db } from '../db/client'
import { devices, leases, recordings, users } from '../db/schema'
import { notFound } from '../http/errors'
import { isUniqueViolation } from './pg-errors'

export const recordingHolder = (recordingId: string) => `recording:${recordingId}`

/** A recording is kept this long after its last change (research R10). */
export const RECORDING_TTL_MS = 7 * 24 * 60 * 60 * 1000

type Status = (typeof recordings.$inferSelect)['status']

export interface RecordingRow {
  id: string
  tenantId: string
  projectId: string
  appId: string
  buildId: string
  deviceId: string
  userId: string
  userName: string
  leaseId: string | null
  status: Status
  steps: RecordingStep[]
  intent: string
  slug: string
  testCaseId: string | null
  createdAt: Date
  updatedAt: Date
  expiresAt: Date
}

const columns = {
  id: recordings.id,
  tenantId: recordings.tenantId,
  projectId: recordings.projectId,
  appId: recordings.appId,
  buildId: recordings.buildId,
  deviceId: recordings.deviceId,
  userId: recordings.userId,
  userName: users.name,
  leaseId: recordings.leaseId,
  status: recordings.status,
  steps: recordings.steps,
  intent: recordings.intent,
  slug: recordings.slug,
  testCaseId: recordings.testCaseId,
  createdAt: recordings.createdAt,
  updatedAt: recordings.updatedAt,
  expiresAt: recordings.expiresAt,
}

const touched = () => {
  const now = new Date()
  return { updatedAt: now, expiresAt: new Date(now.getTime() + RECORDING_TTL_MS) }
}

/**
 * Recordings (data-model §1–3, research R10): a `recording` lease on the device while recording,
 * the steps as JSON, kept 7 days after the last change. Tenant-scoped (P5).
 */
export function recordingsRepo(db: Db, tenantId: string) {
  const select = () =>
    db.select(columns).from(recordings).innerJoin(users, eq(users.id, recordings.userId))
  const mine = (id: string) => and(eq(recordings.tenantId, tenantId), eq(recordings.id, id))

  /** A `recording` lease on the device; undefined when it already has an open one. */
  async function takeLease(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    deviceId: string,
    recordingId: string,
    ttlMs: number,
  ): Promise<string> {
    const [lease] = await tx
      .insert(leases)
      .values({
        tenantId,
        deviceId,
        kind: 'recording',
        holderRef: recordingHolder(recordingId),
        expiresAt: new Date(Date.now() + ttlMs),
      })
      .returning({ id: leases.id })
    if (!lease) throw new Error('lease not stored')
    await tx
      .update(devices)
      .set({ status: 'leased' })
      .where(and(eq(devices.id, deviceId), eq(devices.status, 'idle')))
    return lease.id
  }

  return {
    /**
     * A new recording holding the device; undefined when the device has an open lease (a run,
     * someone's control, another recording — the partial unique index decides).
     */
    async create(input: {
      projectId: string
      appId: string
      buildId: string
      deviceId: string
      userId: string
      slug: string
      leaseTtlMs: number
    }): Promise<RecordingRow | undefined> {
      const id = newId()
      try {
        await db.transaction(async (tx) => {
          const leaseId = await takeLease(tx, input.deviceId, id, input.leaseTtlMs)
          await tx.insert(recordings).values({
            id,
            tenantId,
            projectId: input.projectId,
            appId: input.appId,
            buildId: input.buildId,
            deviceId: input.deviceId,
            userId: input.userId,
            leaseId,
            slug: input.slug,
            ...touched(),
          })
        })
      } catch (error) {
        if (isUniqueViolation(error, 'leases_one_open_per_device')) return undefined
        throw error
      }
      return this.get(id)
    },

    async get(id: string): Promise<RecordingRow> {
      const [row] = await select().where(mine(id))
      if (!row) throw notFound('recording')
      return row as RecordingRow
    },

    async list(filter: { projectId?: string; status?: Status }): Promise<RecordingRow[]> {
      const rows = await select()
        .where(
          and(
            eq(recordings.tenantId, tenantId),
            filter.projectId ? eq(recordings.projectId, filter.projectId) : undefined,
            filter.status ? eq(recordings.status, filter.status) : undefined,
          ),
        )
        .orderBy(desc(recordings.updatedAt))
        .limit(100)
      return rows as RecordingRow[]
    },

    /** Edits (FR-016): steps, intent, slug. Any change keeps the recording 7 more days. */
    async update(
      id: string,
      patch: { steps?: RecordingStep[]; intent?: string; slug?: string },
    ): Promise<RecordingRow> {
      await db
        .update(recordings)
        .set({ ...patch, ...touched() })
        .where(mine(id))
      return this.get(id)
    },

    /** Adds a step, its row locked; a number already used is refused (it names the snapshot). */
    async appendStep(id: string, step: RecordingStep): Promise<void> {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ steps: recordings.steps })
          .from(recordings)
          .where(mine(id))
          .for('update')
        if (!row) throw notFound('recording')
        const steps = row.steps as RecordingStep[]
        if (steps.some((s) => s.n === step.n)) throw new Error(`step ${step.n} already recorded`)
        await tx
          .update(recordings)
          .set({ steps: [...steps, step], ...touched() })
          .where(mine(id))
      })
    },

    /** The next step number, for the snapshot keys of a command still to be sent. */
    async nextStepNumber(id: string): Promise<number> {
      const { steps } = await this.get(id)
      return Math.max(0, ...steps.map((s) => s.n)) + 1
    },

    /** A command keeps the recording's lease alive `ttlMs` more. */
    async touchLease(id: string, ttlMs: number): Promise<void> {
      await db
        .update(leases)
        .set({ expiresAt: new Date(Date.now() + ttlMs) })
        .where(
          and(
            eq(leases.tenantId, tenantId),
            eq(leases.holderRef, recordingHolder(id)),
            isNull(leases.releasedAt),
          ),
        )
    },

    /** Takes the device again for a stopped recording; false when the device is busy. */
    async resume(id: string, ttlMs: number): Promise<boolean> {
      const row = await this.get(id)
      try {
        await db.transaction(async (tx) => {
          const leaseId = await takeLease(tx, row.deviceId, id, ttlMs)
          await tx
            .update(recordings)
            .set({ status: 'recording', leaseId, ...touched() })
            .where(and(mine(id), eq(recordings.status, 'stopped')))
        })
        return true
      } catch (error) {
        if (isUniqueViolation(error, 'leases_one_open_per_device')) return false
        throw error
      }
    },

    /**
     * Moves the recording to `status` (from any of `from`) and forgets its lease; false when it
     * was in none of them. The lease itself is released by the caller (runControl).
     */
    async setStatus(id: string, status: Status, from: readonly Status[]): Promise<boolean> {
      const rows = await db
        .update(recordings)
        .set({
          status,
          leaseId: null,
          ...(status === 'saved' ? { savedAt: new Date() } : {}),
          ...(status === 'stopped' || status === 'saved' ? touched() : {}),
        })
        .where(and(mine(id), inArray(recordings.status, [...from])))
        .returning({ id: recordings.id })
      return rows.length > 0
    },

    async markSaved(id: string, testCaseId: string, slug: string, intent: string) {
      await db
        .update(recordings)
        .set({ status: 'saved', testCaseId, slug, intent, leaseId: null, savedAt: new Date() })
        .where(mine(id))
    },
  }
}

export type RecordingsRepo = ReturnType<typeof recordingsRepo>

/** Recordings holding a device of the agent, across its tenant (agent gone → stop them). */
export function recordingsOnAgent(db: Db, agentId: string) {
  return db
    .select({ id: recordings.id, tenantId: recordings.tenantId, userId: recordings.userId })
    .from(recordings)
    .innerJoin(devices, eq(devices.id, recordings.deviceId))
    .where(and(eq(devices.agentId, agentId), eq(recordings.status, 'recording')))
}

/** Unsaved recordings past `expires_at`, every tenant (the cleanup job, T043). */
export function expiredRecordings(db: Db, now = new Date()) {
  return db
    .select({ id: recordings.id, tenantId: recordings.tenantId })
    .from(recordings)
    .where(and(inArray(recordings.status, ['recording', 'stopped']), lt(recordings.expiresAt, now)))
}
