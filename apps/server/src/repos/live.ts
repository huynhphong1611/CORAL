import { newId } from '@coral/shared'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  apps,
  builds,
  deviceCommands,
  devices,
  leases,
  liveSessions,
  runs,
  users,
} from '../db/schema'
import { isUniqueViolation } from './pg-errors'

export const liveHolder = (sessionId: string) => `live:${sessionId}`

type EndReason = NonNullable<(typeof liveSessions.$inferSelect)['endReason']>
type CommandKind = (typeof deviceCommands.$inferSelect)['kind']
type CommandStatus = (typeof deviceCommands.$inferSelect)['status']

export interface LiveSessionView {
  id: string
  tenantId: string
  deviceId: string
  userId: string
  userName: string
  startedAt: Date
  expiresAt: Date
  endedAt: Date | null
}

const sessionColumns = {
  id: liveSessions.id,
  tenantId: liveSessions.tenantId,
  deviceId: liveSessions.deviceId,
  userId: liveSessions.userId,
  userName: users.name,
  startedAt: liveSessions.startedAt,
  expiresAt: leases.expiresAt,
  endedAt: liveSessions.endedAt,
}

/**
 * Live control sessions (research R7, data-model §1): a `live` lease on the device plus a
 * `live_sessions` row, taken and given back together. Tenant-scoped (P5).
 */
export function liveRepo(db: Db, tenantId: string) {
  const select = () =>
    db
      .select(sessionColumns)
      .from(liveSessions)
      .innerJoin(users, eq(users.id, liveSessions.userId))
      .innerJoin(leases, eq(leases.id, liveSessions.leaseId))

  return {
    /**
     * Takes the device for `userId`: undefined when it already has an open lease (a run, a
     * recording or someone else's control — the partial unique index decides, SC-006).
     */
    async open(
      deviceId: string,
      userId: string,
      ttlMs: number,
    ): Promise<LiveSessionView | undefined> {
      try {
        const id = newId()
        await db.transaction(async (tx) => {
          const [lease] = await tx
            .insert(leases)
            .values({
              tenantId,
              deviceId,
              kind: 'live',
              holderRef: liveHolder(id),
              expiresAt: new Date(Date.now() + ttlMs),
            })
            .returning({ id: leases.id })
          if (!lease) throw new Error('lease not stored')
          await tx
            .insert(liveSessions)
            .values({ id, tenantId, deviceId, userId, leaseId: lease.id })
          await tx
            .update(devices)
            .set({ status: 'leased' })
            .where(and(eq(devices.id, deviceId), eq(devices.status, 'idle')))
        })
        return await this.get(id)
      } catch (error) {
        if (isUniqueViolation(error, 'leases_one_open_per_device')) return undefined
        throw error
      }
    },

    async get(sessionId: string): Promise<LiveSessionView | undefined> {
      const [row] = await select().where(
        and(eq(liveSessions.tenantId, tenantId), eq(liveSessions.id, sessionId)),
      )
      return row
    },

    /** The open session on a device, if any. */
    async current(deviceId: string): Promise<LiveSessionView | undefined> {
      const [row] = await select().where(
        and(
          eq(liveSessions.tenantId, tenantId),
          eq(liveSessions.deviceId, deviceId),
          isNull(liveSessions.endedAt),
        ),
      )
      return row
    },

    /** A command keeps the session alive: its lease now expires `ttlMs` from now. */
    async touch(sessionId: string, ttlMs: number): Promise<Date> {
      const now = new Date()
      const expiresAt = new Date(now.getTime() + ttlMs)
      await db
        .update(liveSessions)
        .set({ lastCommandAt: now })
        .where(and(eq(liveSessions.tenantId, tenantId), eq(liveSessions.id, sessionId)))
      await db
        .update(leases)
        .set({ expiresAt })
        .where(
          and(
            eq(leases.tenantId, tenantId),
            eq(leases.holderRef, liveHolder(sessionId)),
            isNull(leases.releasedAt),
          ),
        )
      return expiresAt
    },

    /** Marks the session ended; false when it had already ended. */
    async end(sessionId: string, reason: EndReason): Promise<boolean> {
      const rows = await db
        .update(liveSessions)
        .set({ endedAt: new Date(), endReason: reason })
        .where(
          and(
            eq(liveSessions.tenantId, tenantId),
            eq(liveSessions.id, sessionId),
            isNull(liveSessions.endedAt),
          ),
        )
        .returning({ id: liveSessions.id })
      return rows.length > 0
    },

    /** FR-009: what was done, never the text typed (params hold `length` / `secret` only). */
    async recordCommand(input: {
      /** The command id sent to the agent, so the row and the agent logs match. */
      id?: string
      deviceId: string
      /** The command belongs to a control session or to a recording. */
      liveSessionId?: string
      recordingId?: string
      userId: string
      kind: CommandKind
      params: Record<string, unknown>
    }): Promise<string> {
      const [row] = await db
        .insert(deviceCommands)
        .values({ tenantId, ...input })
        .returning({ id: deviceCommands.id })
      if (!row) throw new Error('command not stored')
      return row.id
    },

    async finishCommand(id: string, status: CommandStatus, error?: string): Promise<void> {
      await db
        .update(deviceCommands)
        .set({ status, error: error ?? null, finishedAt: new Date() })
        .where(and(eq(deviceCommands.tenantId, tenantId), eq(deviceCommands.id, id)))
    },

    /** Package of the app last run on the device: what "restart app" restarts (P6). */
    async lastAppPackage(deviceId: string): Promise<string | undefined> {
      const [row] = await db
        .select({ pkg: apps.packageOrBundleId })
        .from(runs)
        .innerJoin(builds, eq(builds.id, runs.buildId))
        .innerJoin(apps, eq(apps.id, builds.appId))
        .where(and(eq(runs.tenantId, tenantId), eq(runs.deviceId, deviceId)))
        .orderBy(desc(runs.queuedAt))
        .limit(1)
      return row?.pkg
    },
  }
}

export type LiveRepo = ReturnType<typeof liveRepo>

/** Open sessions of an agent's devices, across the agent's tenant (agent gone → end them). */
export function openSessionsOnAgent(db: Db, agentId: string) {
  return db
    .select(sessionColumns)
    .from(liveSessions)
    .innerJoin(users, eq(users.id, liveSessions.userId))
    .innerJoin(leases, eq(leases.id, liveSessions.leaseId))
    .innerJoin(devices, eq(devices.id, liveSessions.deviceId))
    .where(and(eq(devices.agentId, agentId), isNull(liveSessions.endedAt)))
}
