import { api } from '@coral/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { devices, leases } from '../db/schema'
import { fakeAgent } from '../testing/fake-agent'
import { startRunServer, type RunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'

let server: RunServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

async function setup(options: Parameters<typeof startRunServer>[0] = {}) {
  server = await startRunServer(options)
  const huynh = await server.newUser('Huynh')
  const fixture = await server.seed(huynh)
  const agent = await fakeAgent(server.url, fixture.agent.token)
  const [device] = await server.db
    .select()
    .from(devices)
    .where(eq(devices.agentId, fixture.agent.id))
  const s = server
  const createRun = async (user: TestUser = huynh) => {
    const res = await s.call(user, {
      method: 'POST',
      url: '/runs',
      payload: {
        project_id: fixture.project.id,
        build_id: fixture.build.id,
        device_id: device?.id,
        test_case_ids: [fixture.testCase.id],
      },
    })
    expect(res.status).toBe(201)
    return (res.body as { id: string }).id
  }
  const getRun = async (id: string) =>
    api.runSchema.parse((await s.call(huynh, { method: 'GET', url: `/runs/${id}` })).body)
  const openLeases = () =>
    s.db
      .select()
      .from(leases)
      .where(and(eq(leases.deviceId, device?.id ?? ''), isNull(leases.releasedAt)))
  const allLeases = () =>
    s.db
      .select()
      .from(leases)
      .where(eq(leases.deviceId, device?.id ?? ''))
  return {
    server,
    huynh,
    fixture,
    agent,
    deviceId: device?.id ?? '',
    createRun,
    getRun,
    openLeases,
    allLeases,
  }
}

const until = async (check: () => Promise<boolean>, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('condition not met in time')
}

describe('dispatcher and device leases', () => {
  // SC-007: never two open leases on one device, even with 10 runs created at once.
  it('runs 10 concurrent runs on one device one after another', async () => {
    const t = await setup()
    const ids = await Promise.all(Array.from({ length: 10 }, () => t.createRun()))
    const order: string[] = []
    for (let i = 0; i < 10; i++) {
      const job = await t.agent.nextJob()
      expect(await t.openLeases()).toHaveLength(1)
      order.push(job.payload.run_id)
      expect(job.payload).toMatchObject({
        device_udid: 'emulator-5554',
        build: { package: 'com.example.app', sha256: t.fixture.build.checksum_sha256 },
        secrets: { TEST_USER: 'bob@example.com' },
        items: [{ test_case_id: t.fixture.testCase.id, commit: t.fixture.testCase.head_commit }],
      })
      expect(job.payload.items[0]?.yaml).toContain('id: login')
      expect(job.payload.popups_yaml).toContain('schema: coral/popups@1')
      t.agent.ack(job)
      await until(async () => (await t.getRun(job.payload.run_id)).status === 'running')
      const itemId = job.payload.items[0]?.run_item_id ?? ''
      t.agent.step(job.payload, itemId, 0, 's1')
      t.agent.item(job.payload, itemId, 'passed')
      t.agent.done(job.payload, 'passed')
      await until(async () => (await t.getRun(job.payload.run_id)).status === 'passed')
    }
    expect(order.sort()).toEqual([...ids].sort())
    await until(async () => (await t.openLeases()).length === 0)
    const released = await t.allLeases()
    expect(released).toHaveLength(10)
    expect(released.every((l) => l.releasedAt !== null && l.releaseReason === 'done')).toBe(true)
    const [device] = await t.server.db.select().from(devices).where(eq(devices.id, t.deviceId))
    expect(device?.status).toBe('idle')
  }, 30_000)

  it('releases the lease when job.ack never comes, retries once, then ends as TIMEOUT', async () => {
    const t = await setup({ ackTimeoutMs: 300 })
    const id = await t.createRun()
    await t.agent.nextJob()
    await t.agent.nextJob()
    await until(async () => (await t.getRun(id)).status === 'error')
    expect(await t.getRun(id)).toMatchObject({
      failure_code: 'TIMEOUT',
      items: [{ status: 'skipped' }],
    })
    const reasons = (await t.allLeases()).map((l) => l.releaseReason)
    expect(reasons).toEqual(['ack_timeout', 'ack_timeout'])
  }, 20_000)

  it('retries after job.reject', async () => {
    const t = await setup()
    const id = await t.createRun()
    const first = await t.agent.nextJob()
    t.agent.client.send('job.reject', { run_id: id, reason: 'device busy' }, first.id)
    const second = await t.agent.nextJob()
    t.agent.ack(second)
    await until(async () => (await t.getRun(id)).status === 'running')
  }, 20_000)

  it('ends a run that never gets its device as TIMEOUT after the queue timeout', async () => {
    const t = await setup({ queueTimeoutMs: 400 })
    t.agent.close()
    await until(async () => !t.server.gateway.isOnline(t.fixture.agent.id))
    const id = await t.createRun()
    await until(async () => (await t.getRun(id)).status === 'error')
    expect(await t.getRun(id)).toMatchObject({ failure_code: 'TIMEOUT' })
    expect(await t.allLeases()).toEqual([])
  }, 20_000)

  it('cancels a run that runs past the run timeout', async () => {
    const t = await setup({ runTimeoutMs: 400 })
    const id = await t.createRun()
    const job = await t.agent.nextJob()
    t.agent.ack(job)
    // The item has started when the timeout hits.
    t.agent.step(job.payload, job.payload.items[0]?.run_item_id ?? '', 0, 's1')
    const cancel = await t.agent.client.next('job.cancel', undefined, 5000)
    expect(cancel.payload).toEqual({ run_id: id, reason: 'timeout' })
    await until(async () => (await t.getRun(id)).status === 'error')
    expect(await t.getRun(id)).toMatchObject({
      failure_code: 'TIMEOUT',
      items: [{ status: 'error', failure_code: 'TIMEOUT' }],
    })
    expect((await t.server.releasedLease(id)).releaseReason).toBe('timeout')
  }, 20_000)
})
