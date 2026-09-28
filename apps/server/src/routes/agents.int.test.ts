import { api } from '@coral/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashToken } from '../auth/tokens'
import { agents, auditLog } from '../db/schema'
import { findAgentByToken } from '../repos/agents'
import { startTestServer, type TestServer, type TestUser } from '../testing/test-server'

const disconnected: [string, number][] = []
let server: TestServer
let huynh: TestUser

beforeAll(async () => {
  server = await startTestServer({
    connections: { disconnect: (id, code) => void disconnected.push([id, code]) },
  })
  huynh = await server.newUser('Huynh')
})
afterAll(() => server.close())

describe('agents', () => {
  it('returns the token once and stores only its hash', async () => {
    const res = await server.call(huynh, {
      method: 'POST',
      url: '/agents',
      payload: { name: 'laptop' },
    })
    expect(res.status).toBe(201)
    const created = api.createdAgentSchema.parse(res.body)
    const [row] = await server.db.select().from(agents).where(eq(agents.id, created.id))
    expect(row?.tokenHash).toBe(hashToken(created.token))
    expect(JSON.stringify(row)).not.toContain(created.token)
    expect((await findAgentByToken(server.db, created.token))?.id).toBe(created.id)

    const list = api.agentSchema
      .array()
      .parse((await server.call(huynh, { method: 'GET', url: '/agents' })).body)
    expect(list).toMatchObject([
      { id: created.id, name: 'laptop', status: 'offline', last_seen_at: null },
    ])
    expect(JSON.stringify(list)).not.toContain(created.token)
  })

  it('revokes: token stops working, live connection is closed, audit is written', async () => {
    const created = api.createdAgentSchema.parse(
      (await server.call(huynh, { method: 'POST', url: '/agents', payload: { name: 'ci' } })).body,
    )
    const res = await server.call(huynh, { method: 'POST', url: `/agents/${created.id}/revoke` })
    expect(res.status).toBe(204)
    expect(await findAgentByToken(server.db, created.token)).toBeUndefined()
    expect(disconnected).toContainEqual([created.id, 4401])
    const actions = (
      await server.db.select().from(auditLog).where(eq(auditLog.tenantId, huynh.tenantId))
    ).map((a) => a.action)
    expect(actions).toEqual(expect.arrayContaining(['agent.create', 'agent.revoke']))
  })

  it('isolates tenants', async () => {
    const created = api.createdAgentSchema.parse(
      (await server.call(huynh, { method: 'POST', url: '/agents', payload: { name: 'mine' } }))
        .body,
    )
    const other = await server.newUser('Other')
    expect(
      (await server.call(other, { method: 'POST', url: `/agents/${created.id}/revoke` })).status,
    ).toBe(404)
    expect((await server.call(other, { method: 'GET', url: '/agents' })).body).toEqual([])
    expect((await server.call(other, { method: 'GET', url: '/devices' })).body).toEqual([])
  })

  it('rejects tokens with the wrong prefix without a lookup', async () => {
    expect(await findAgentByToken(server.db, 'Bearer nope')).toBeUndefined()
  })
})
