import { newId } from '@coral/shared'
import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../config'
import { createDatabase } from './client'
import {
  BUSINESS_TABLES,
  agents,
  deviceCommands,
  devices,
  leases,
  liveSessions,
  tenants,
  users,
} from './schema'

const database = createDatabase(loadConfig(process.env).databaseUrl)
const { db } = database
afterAll(() => database.close())

async function seedDevice() {
  const [tenant] = await db
    .insert(tenants)
    .values({ name: `t-${newId()}` })
    .returning()
  if (!tenant) throw new Error('no tenant')
  const [agent] = await db
    .insert(agents)
    .values({ tenantId: tenant.id, name: 'laptop', tokenHash: newId() })
    .returning()
  if (!agent) throw new Error('no agent')
  const [device] = await db
    .insert(devices)
    .values({
      tenantId: tenant.id,
      agentId: agent.id,
      platform: 'android',
      kind: 'emulator',
      model: 'sdk_gphone64',
      osVersion: '14',
      apiLevel: 34,
      udid: 'emulator-5554',
    })
    .returning()
  if (!device) throw new Error('no device')
  return { tenantId: tenant.id, deviceId: device.id }
}

const lease = (tenantId: string, deviceId: string, kind: 'run' | 'live' | 'recording' = 'run') => ({
  tenantId,
  deviceId,
  kind,
  holderRef: `${kind}:${newId()}`,
  expiresAt: new Date(Date.now() + 60_000),
})

describe('Phase 1 schema (data-model.md)', () => {
  it('gives every business table a non-null tenant_id (P5)', async () => {
    const { rows } = await db.execute<{ table_name: string; is_nullable: string }>(sql`
      select table_name, is_nullable from information_schema.columns
      where table_schema = 'public' and column_name = 'tenant_id'`)
    const byTable = new Map(rows.map((r) => [r.table_name, r.is_nullable]))
    for (const table of BUSINESS_TABLES) expect(byTable.get(table), table).toBe('NO')
    for (const global of ['users', 'refresh_tokens']) expect(byTable.has(global)).toBe(false)
  })

  it('allows only one open lease per device (D16, SC-007)', async () => {
    const { tenantId, deviceId } = await seedDevice()
    await db.insert(leases).values(lease(tenantId, deviceId))
    await expect(db.insert(leases).values(lease(tenantId, deviceId))).rejects.toThrow()
  })

  it('allows a new lease once the previous one is released', async () => {
    const { tenantId, deviceId } = await seedDevice()
    const [first] = await db.insert(leases).values(lease(tenantId, deviceId)).returning()
    await db
      .update(leases)
      .set({ releasedAt: new Date(), releaseReason: 'done' })
      .where(sql`${leases.id} = ${first?.id}`)
    await expect(db.insert(leases).values(lease(tenantId, deviceId))).resolves.toBeDefined()
  })

  it('rejects values outside the documented enums', async () => {
    const { tenantId, deviceId } = await seedDevice()
    await expect(
      db.execute(
        sql`update devices set status = 'broken' where id = ${deviceId} and tenant_id = ${tenantId}`,
      ),
    ).rejects.toMatchObject({ cause: { constraint: 'devices_status' } })
  })
})

describe('Phase 2 schema (specs/003-phase-2-web-recorder/data-model.md)', () => {
  async function seedUser() {
    const [user] = await db
      .insert(users)
      .values({ email: `u-${newId()}@coral.test`, passwordHash: 'x', name: 'Huynh' })
      .returning()
    if (!user) throw new Error('no user')
    return user.id
  }

  it('never lets a control session or a recording share a device with a run (SC-006)', async () => {
    for (const second of ['live', 'recording'] as const) {
      const { tenantId, deviceId } = await seedDevice()
      await db.insert(leases).values(lease(tenantId, deviceId, 'run'))
      await expect(db.insert(leases).values(lease(tenantId, deviceId, second))).rejects.toThrow()
    }
  })

  it('keeps one open live session per device', async () => {
    const { tenantId, deviceId } = await seedDevice()
    const userId = await seedUser()
    const [held] = await db
      .insert(leases)
      .values(lease(tenantId, deviceId, 'live'))
      .returning()
    if (!held) throw new Error('no lease')
    const session = { tenantId, deviceId, userId, leaseId: held.id }
    await db.insert(liveSessions).values(session)
    await expect(db.insert(liveSessions).values(session)).rejects.toThrow()
  })

  it('rejects unknown command kinds and statuses (FR-009)', async () => {
    const { tenantId, deviceId } = await seedDevice()
    const userId = await seedUser()
    await expect(
      db
        .insert(deviceCommands)
        .values({ tenantId, deviceId, userId, kind: 'tap', params: { x: 1, y: 2 } }),
    ).resolves.toBeDefined()
    await expect(
      db.execute(
        sql`insert into device_commands (id, tenant_id, device_id, user_id, kind) values (${newId()}, ${tenantId}, ${deviceId}, ${userId}, 'shell')`,
      ),
    ).rejects.toMatchObject({ cause: { constraint: 'device_commands_kind' } })
    await db.insert(leases).values(lease(tenantId, deviceId, 'recording'))
    await expect(
      db.execute(sql`update leases set kind = 'party' where device_id = ${deviceId}`),
    ).rejects.toMatchObject({ cause: { constraint: 'leases_kind' } })
  })
})
