import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { agents, devices, leases, liveSessions, recordings, runs, users } from '../db/schema'
import { hashToken, newOpaqueToken } from '../auth/tokens'
import { notFound } from '../http/errors'

export const AGENT_TOKEN_PREFIX = 'coral_agt_'

export type AgentRow = typeof agents.$inferSelect
export type DeviceRow = typeof devices.$inferSelect

/** An open lease with the person behind it: who controls, records or started the run. */
export interface OpenLease {
  deviceId: string
  kind: (typeof leases.$inferSelect)['kind']
  holderRef: string
  acquiredAt: Date
  userId: string | null
  userName: string | null
}

/** Agents and devices of one tenant, as the operator sees them. */
export function agentsRepo(db: Db, tenantId: string) {
  return {
    list() {
      return db
        .select()
        .from(agents)
        .where(eq(agents.tenantId, tenantId))
        .orderBy(asc(agents.createdAt))
    },

    async get(id: string): Promise<AgentRow> {
      const [row] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.tenantId, tenantId), eq(agents.id, id)))
      if (!row) throw notFound('agent')
      return row
    },

    /** The token is returned here once and only its SHA-256 is stored (FR-020). */
    async create(name: string): Promise<{ agent: AgentRow; token: string }> {
      const token = newOpaqueToken(AGENT_TOKEN_PREFIX)
      const [agent] = await db
        .insert(agents)
        .values({ tenantId, name, tokenHash: hashToken(token) })
        .returning()
      if (!agent) throw new Error('agent not stored')
      return { agent, token }
    },

    async revoke(id: string): Promise<void> {
      await this.get(id)
      await db.transaction(async (tx) => {
        await tx
          .update(agents)
          .set({ status: 'revoked', revokedAt: new Date() })
          .where(and(eq(agents.tenantId, tenantId), eq(agents.id, id)))
        await tx
          .update(devices)
          .set({ status: 'offline' })
          .where(and(eq(devices.tenantId, tenantId), eq(devices.agentId, id)))
      })
    },

    listDevices() {
      return db
        .select()
        .from(devices)
        .where(eq(devices.tenantId, tenantId))
        .orderBy(asc(devices.createdAt))
    },

    /** Open leases of the tenant's devices (at most one per device, D16). */
    openLeases(): Promise<OpenLease[]> {
      return db
        .select({
          deviceId: leases.deviceId,
          kind: leases.kind,
          holderRef: leases.holderRef,
          acquiredAt: leases.acquiredAt,
          userId: users.id,
          userName: users.name,
        })
        .from(leases)
        .leftJoin(
          liveSessions,
          and(eq(liveSessions.tenantId, tenantId), eq(liveSessions.leaseId, leases.id)),
        )
        .leftJoin(
          recordings,
          and(eq(recordings.tenantId, tenantId), eq(recordings.leaseId, leases.id)),
        )
        .leftJoin(
          runs,
          and(eq(runs.tenantId, tenantId), sql`${leases.holderRef} = 'run:' || ${runs.id}::text`),
        )
        .leftJoin(
          users,
          sql`${users.id} = coalesce(${liveSessions.userId}, ${recordings.userId}, ${runs.createdBy})`,
        )
        .where(and(eq(leases.tenantId, tenantId), isNull(leases.releasedAt)))
    },

    async getDevice(id: string): Promise<DeviceRow> {
      const [row] = await db
        .select()
        .from(devices)
        .where(and(eq(devices.tenantId, tenantId), eq(devices.id, id)))
      if (!row) throw notFound('device')
      return row
    },
  }
}

/** Token lookup for the agent WebSocket; the tenant comes from the agent row. */
export async function findAgentByToken(db: Db, token: string): Promise<AgentRow | undefined> {
  if (!token.startsWith(AGENT_TOKEN_PREFIX)) return undefined
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.tokenHash, hashToken(token)), isNull(agents.revokedAt)))
  return row
}
