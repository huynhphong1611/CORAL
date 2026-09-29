import { api } from '@coral/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { devices, leases } from '../db/schema'
import { fakeAgent } from '../testing/fake-agent'
import { startRunServer, type RunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'
import { startLeaseSweeper } from './ingest'

let server: RunServer
let huynh: TestUser

beforeAll(async () => {
  server = await startRunServer()
  huynh = await server.newUser('Huynh')
})
afterAll(() => server.close())

// A lease left open by a server that died: no heartbeat will ever extend or release it.
describe('lease sweeper', () => {
  it('releases expired leases, ends their run as DEVICE_OFFLINE and frees the device', async () => {
    const fixture = await server.seed(huynh)
    const agent = await fakeAgent(server.url, fixture.agent.token)
    const [device] = await server.db
      .select()
      .from(devices)
      .where(eq(devices.agentId, fixture.agent.id))
    const created = await server.call(huynh, {
      method: 'POST',
      url: '/runs',
      payload: {
        project_id: fixture.project.id,
        build_id: fixture.build.id,
        device_id: device?.id,
        test_case_ids: [fixture.testCase.id],
      },
    })
    const id = (created.body as { id: string }).id
    const job = await agent.nextJob()
    agent.ack(job)
    const getRun = async () =>
      api.runSchema.parse((await server.call(huynh, { method: 'GET', url: `/runs/${id}` })).body)
    const deadline = Date.now() + 5000
    while ((await getRun()).status !== 'running' && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25))

    // Simulate "server restarted long ago": the lease is past its expiry.
    await server.db
      .update(leases)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(leases.holderRef, `run:${id}`))
    const sweeper = startLeaseSweeper({
      db: server.db,
      dispatcher: server.dispatcher,
      intervalMs: 60_000,
    })
    await sweeper.first // the first sweep runs at start
    sweeper.stop()

    expect(await getRun()).toMatchObject({
      status: 'error',
      failure_code: 'DEVICE_OFFLINE',
      items: [{ status: 'skipped' }],
    })
    const [lease] = await server.db
      .select()
      .from(leases)
      .where(eq(leases.holderRef, `run:${id}`))
    expect(lease?.releaseReason).toBe('timeout')
    const [after] = await server.db
      .select()
      .from(devices)
      .where(eq(devices.id, device?.id ?? ''))
    expect(after?.status).toBe('idle')
    expect(await sweeper.sweep()).toBe(0)
    agent.close()
  })
})
