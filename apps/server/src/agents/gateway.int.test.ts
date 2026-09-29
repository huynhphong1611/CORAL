import { api } from '@coral/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agents, devices, leases } from '../db/schema'
import { startTestServer, type TestServer, type TestUser } from '../testing/test-server'
import { connectAgent, emulator, hello } from '../testing/ws-client'
import { AgentGateway, CLOSE, MAX_INVALID_PER_MINUTE, type AgentRef } from './gateway'

const HEARTBEAT_MS = 150
const offline: AgentRef[] = []
let server: TestServer
let url = ''
let huynh: TestUser

beforeAll(async () => {
  server = await startTestServer(({ db }) => {
    const gateway = new AgentGateway({ db, heartbeatMs: HEARTBEAT_MS })
    gateway.onAgentOffline((agent) => void offline.push(agent))
    return { gateway }
  })
  url = await server.listen()
  huynh = await server.newUser('Huynh')
})
afterAll(() => server.close())

async function online(name: string, devs = [emulator()], beat = true) {
  const agent = await server.newAgent(huynh, name)
  const client = await connectAgent(url, agent.token)
  if (beat) client.heartbeat(HEARTBEAT_MS / 3)
  const sent = client.send('agent.hello', hello(devs))
  const welcome = await client.next('agent.welcome', sent.id)
  return { agent, client, welcome }
}

const deviceRows = (agentId: string) =>
  server.db.select().from(devices).where(eq(devices.agentId, agentId))

describe('agent gateway', () => {
  it('closes with 4401 on a missing, wrong or revoked token', async () => {
    expect((await (await connectAgent(url, undefined)).closed).code).toBe(CLOSE.unauthorized)
    expect((await (await connectAgent(url, 'coral_agt_nope')).closed).code).toBe(CLOSE.unauthorized)
  })

  it('answers hello with welcome (re = hello id), stores the agent and its devices', async () => {
    const { agent, client, welcome } = await online('laptop', [
      emulator('emulator-5554'),
      emulator('emulator-5556'),
    ])
    expect(welcome.payload).toEqual({ agent_id: agent.id, heartbeat_ms: HEARTBEAT_MS })
    const [row] = await server.db.select().from(agents).where(eq(agents.id, agent.id))
    expect(row).toMatchObject({ status: 'online', os: 'linux', version: '0.1.0' })
    const list = api.deviceSchema
      .array()
      .parse((await server.call(huynh, { method: 'GET', url: '/devices' })).body)
    expect(
      list
        .filter((d) => d.agent_id === agent.id)
        .map((d) => [d.udid, d.status])
        .sort(),
    ).toEqual([
      ['emulator-5554', 'idle'],
      ['emulator-5556', 'idle'],
    ])
    client.close()
  })

  it('applies device.update (added, changed, removed)', async () => {
    const { agent, client } = await online('updates')
    client.send('device.update', {
      added: [emulator('R58M')],
      changed: [{ ...emulator(), model: 'Pixel 7' }],
      removed: ['emulator-5554'],
    })
    client.send('agent.heartbeat', { devices: [] })
    await new Promise((r) => setTimeout(r, 200))
    const rows = await deviceRows(agent.id)
    expect(rows.map((d) => [d.udid, d.status, d.model]).sort()).toEqual([
      ['R58M', 'idle', 'sdk_gphone64_x86_64'],
      ['emulator-5554', 'offline', 'Pixel 7'],
    ])
    client.close()
  })

  it('extends open leases on each heartbeat', async () => {
    const { agent, client } = await online('leases')
    const [device] = await deviceRows(agent.id)
    const soon = new Date(Date.now() + 50)
    await server.db.insert(leases).values({
      tenantId: huynh.tenantId,
      deviceId: device?.id ?? '',
      kind: 'run',
      holderRef: 'run:test',
      expiresAt: soon,
    })
    client.send('agent.heartbeat', { devices: [{ udid: 'emulator-5554', status: 'busy' }] })
    await new Promise((r) => setTimeout(r, 200))
    const [lease] = await server.db
      .select()
      .from(leases)
      .where(eq(leases.deviceId, device?.id ?? ''))
    expect(lease?.expiresAt.getTime()).toBeGreaterThan(soon.getTime())
    await server.db
      .update(leases)
      .set({ releasedAt: new Date(), releaseReason: 'done' })
      .where(eq(leases.deviceId, device?.id ?? ''))
    client.close()
  })

  it('requires hello first and refuses server-only message types', async () => {
    const agent = await server.newAgent(huynh, 'early')
    const client = await connectAgent(url, agent.token)
    const early = client.send('agent.heartbeat', { devices: [] })
    client.heartbeat(HEARTBEAT_MS / 3)
    expect((await client.next('error', early.id)).payload).toMatchObject({ code: 'hello_required' })
    client.send('agent.hello', hello([]))
    await client.next('agent.welcome')
    const wrong = client.send('job.cancel', {
      run_id: '0192f000-0000-7000-8000-000000000001',
      reason: 'x',
    })
    expect((await client.next('error', wrong.id)).payload).toMatchObject({
      code: 'invalid_message',
    })
    client.close()
  })

  it('answers invalid messages with error, then closes with 4400 after too many', async () => {
    const { client } = await online('noisy')
    client.ws.send('{not json')
    expect((await client.next('error')).payload).toMatchObject({ code: 'invalid_message' })
    for (let i = 0; i < MAX_INVALID_PER_MINUTE; i++) client.ws.send('{}')
    expect((await client.closed).code).toBe(CLOSE.tooManyInvalid)
  })

  it('marks the agent and its devices offline after missed heartbeats', async () => {
    const { agent, client } = await online('silent', [emulator()], false)
    const closed = await client.closed
    expect(closed.code).toBe(CLOSE.heartbeatTimeout)
    await new Promise((r) => setTimeout(r, 100))
    const [row] = await server.db.select().from(agents).where(eq(agents.id, agent.id))
    expect(row?.status).toBe('offline')
    expect((await deviceRows(agent.id)).map((d) => d.status)).toEqual(['offline'])
    expect(offline.map((a) => a.id)).toContain(agent.id)
  })

  it('closes a revoked agent with 4401 and replaces an older connection with 4409', async () => {
    const first = await online('twice')
    const second = await connectAgent(url, first.agent.token)
    second.heartbeat(HEARTBEAT_MS / 3)
    expect((await first.client.closed).code).toBe(CLOSE.replaced)
    second.send('agent.hello', hello([emulator()]))
    await second.next('agent.welcome')
    // The replaced connection must not flip the agent offline.
    await new Promise((r) => setTimeout(r, 50))
    const [row] = await server.db.select().from(agents).where(eq(agents.id, first.agent.id))
    expect(row?.status).toBe('online')

    await server.call(huynh, { method: 'POST', url: `/agents/${first.agent.id}/revoke` })
    expect((await second.closed).code).toBe(CLOSE.unauthorized)
  })
})
