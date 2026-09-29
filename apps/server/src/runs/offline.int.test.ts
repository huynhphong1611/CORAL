import { api } from '@coral/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { devices, runSteps } from '../db/schema'
import { fakeAgent } from '../testing/fake-agent'
import { startRunServer, type RunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'

const HEARTBEAT_MS = 150
let server: RunServer
let huynh: TestUser

beforeAll(async () => {
  server = await startRunServer({ heartbeatMs: HEARTBEAT_MS })
  huynh = await server.newUser('Huynh')
})
afterAll(() => server.close())

const until = async (check: () => Promise<boolean>, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('condition not met in time')
}

// SC-009: an agent that stops mid-run ends the run as DEVICE_OFFLINE within 3 heartbeats.
describe('agent offline during a run', () => {
  it('ends the run as DEVICE_OFFLINE, frees the lease and ignores late messages', async () => {
    const fixture = await server.seed(huynh)
    const agent = await fakeAgent(server.url, fixture.agent.token, {
      heartbeatMs: HEARTBEAT_MS / 3,
    })
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
    const itemId = job.payload.items[0]?.run_item_id ?? ''
    agent.step(job.payload, itemId, 0, 's1')
    const getRun = async () =>
      api.runSchema.parse((await server.call(huynh, { method: 'GET', url: `/runs/${id}` })).body)
    await until(async () => (await getRun()).status === 'running')

    // The agent process freezes: the socket stays open, nothing is sent any more.
    agent.client.stopHeartbeat()
    const stoppedAt = Date.now()
    await until(async () => (await getRun()).status === 'error', 5000)
    expect(Date.now() - stoppedAt).toBeLessThan(HEARTBEAT_MS * 3 + 1500)

    const run = await getRun()
    expect(run).toMatchObject({
      failure_code: 'DEVICE_OFFLINE',
      items: [{ status: 'error', failure_code: 'DEVICE_OFFLINE' }],
    })
    const lease = await server.releasedLease(id)
    expect(lease.releaseReason).toBe('agent_offline')
    const [after] = await server.db
      .select()
      .from(devices)
      .where(eq(devices.id, device?.id ?? ''))
    expect(after?.status).toBe('offline')

    // The agent comes back and sends what it had queued: ignored.
    const back = await fakeAgent(server.url, fixture.agent.token, { heartbeatMs: HEARTBEAT_MS / 3 })
    back.step(job.payload, itemId, 1, 's2')
    back.done(job.payload, 'passed')
    await new Promise((r) => setTimeout(r, 200))
    expect((await getRun()).status).toBe('error')
    expect(
      await server.db.select().from(runSteps).where(eq(runSteps.runItemId, itemId)),
    ).toHaveLength(1)
    back.close()
  })
})
