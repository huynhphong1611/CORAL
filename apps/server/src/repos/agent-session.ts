import type { protocol } from '@coral/shared'
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { agents, devices, leases } from '../db/schema'

type DeviceInfo = protocol.DeviceInfo

/**
 * What a connected agent may change: its own row, its devices and the leases on them. The tenant
 * comes from the authenticated agent, never from a message (P5).
 */
export function agentSessionRepo(db: Db, agent: { id: string; tenantId: string }) {
  const own = and(eq(devices.tenantId, agent.tenantId), eq(devices.agentId, agent.id))

  /** idle unless a lease is open on it (the lease state belongs to the server). */
  async function leasedIds(): Promise<Set<string>> {
    const rows = await db
      .select({ deviceId: leases.deviceId })
      .from(leases)
      .innerJoin(devices, eq(devices.id, leases.deviceId))
      .where(and(own, isNull(leases.releasedAt)))
    return new Set(rows.map((r) => r.deviceId))
  }

  async function upsert(list: readonly DeviceInfo[], now: Date): Promise<void> {
    if (list.length === 0) return
    const leased = await leasedIds()
    for (const device of list) {
      const values = {
        tenantId: agent.tenantId,
        agentId: agent.id,
        platform: device.platform,
        kind: device.kind,
        model: device.model,
        osVersion: device.os_version,
        apiLevel: device.api_level,
        udid: device.udid,
        lastSeenAt: now,
      }
      const [row] = await db
        .insert(devices)
        .values({ ...values, status: device.status === 'offline' ? 'offline' : 'idle' })
        .onConflictDoUpdate({
          target: [devices.agentId, devices.udid],
          set: {
            kind: values.kind,
            model: values.model,
            osVersion: values.osVersion,
            apiLevel: values.apiLevel,
            lastSeenAt: now,
          },
        })
        .returning({ id: devices.id })
      if (!row) continue
      const status =
        device.status === 'offline' ? 'offline' : leased.has(row.id) ? 'leased' : 'idle'
      await db.update(devices).set({ status }).where(eq(devices.id, row.id))
    }
  }

  return {
    /** `agent.hello`: agent online, its device list replaces the previous one. */
    async hello(input: {
      os: string
      version: string
      capabilities: unknown
      devices: readonly DeviceInfo[]
      now: Date
    }): Promise<void> {
      await db
        .update(agents)
        .set({
          status: 'online',
          os: input.os,
          version: input.version,
          capabilities: input.capabilities,
          lastSeenAt: input.now,
        })
        .where(and(eq(agents.id, agent.id), eq(agents.tenantId, agent.tenantId)))
      await upsert(input.devices, input.now)
      const present = input.devices.map((d) => d.udid)
      await db
        .update(devices)
        .set({ status: 'offline' })
        .where(present.length > 0 ? and(own, notInArray(devices.udid, present)) : own)
    },

    /** `device.update` */
    async updateDevices(input: {
      added: readonly DeviceInfo[]
      changed: readonly DeviceInfo[]
      removed: readonly string[]
      now: Date
    }): Promise<void> {
      await upsert([...input.added, ...input.changed], input.now)
      if (input.removed.length > 0) {
        await db
          .update(devices)
          .set({ status: 'offline' })
          .where(and(own, inArray(devices.udid, [...input.removed])))
      }
    },

    /**
     * `agent.heartbeat`: last seen + the open run leases on this agent's devices extended by
     * `ttlMs`. A person's lease (live, recording) is not: it ends after their idle time (R7).
     */
    async heartbeat(now: Date, ttlMs: number): Promise<void> {
      await db
        .update(agents)
        .set({ lastSeenAt: now })
        .where(and(eq(agents.id, agent.id), eq(agents.tenantId, agent.tenantId)))
      await db
        .update(devices)
        .set({ lastSeenAt: now })
        .where(and(own, sql`${devices.status} <> 'offline'`))
      await db
        .update(leases)
        .set({ expiresAt: new Date(now.getTime() + ttlMs) })
        .where(
          and(
            isNull(leases.releasedAt),
            inArray(leases.kind, ['run', 'exploration']),
            inArray(leases.deviceId, db.select({ id: devices.id }).from(devices).where(own)),
          ),
        )
    },

    /** Connection lost or closed: the agent and all its devices go offline (SC-009). */
    async offline(): Promise<void> {
      await db
        .update(agents)
        .set({ status: 'offline' })
        .where(
          and(
            eq(agents.id, agent.id),
            eq(agents.tenantId, agent.tenantId),
            eq(agents.status, 'online'),
          ),
        )
      await db.update(devices).set({ status: 'offline' }).where(own)
    },

    async deviceIdByUdid(udid: string): Promise<string | undefined> {
      const [row] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(own, eq(devices.udid, udid)))
      return row?.id
    },
  }
}

export type AgentSessionRepo = ReturnType<typeof agentSessionRepo>
