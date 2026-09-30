import { api } from '@coral/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLog, devices, runSteps } from '../db/schema'
import { fakeAgent } from '../testing/fake-agent'
import { startRunServer, type RunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'

let server: RunServer
let huynh: TestUser
let fixture: Awaited<ReturnType<RunServer['seed']>>
let agent: Awaited<ReturnType<typeof fakeAgent>>
let deviceId = ''

beforeAll(async () => {
  server = await startRunServer()
  huynh = await server.newUser('Huynh')
  fixture = await server.seed(huynh)
  agent = await fakeAgent(server.url, fixture.agent.token)
  const [device] = await server.db
    .select()
    .from(devices)
    .where(eq(devices.agentId, fixture.agent.id))
  deviceId = device?.id ?? ''
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

async function startRun() {
  const res = await server.call(huynh, {
    method: 'POST',
    url: '/runs',
    payload: {
      project_id: fixture.project.id,
      build_id: fixture.build.id,
      device_id: deviceId,
      test_case_ids: [fixture.testCase.id],
    },
  })
  const id = (res.body as { id: string }).id
  const job = await agent.nextJob()
  agent.ack(job)
  await until(async () => (await getRun(id)).status === 'running')
  return { id, job, itemId: job.payload.items[0]?.run_item_id ?? '' }
}

const getRun = async (id: string) =>
  api.runSchema.parse((await server.call(huynh, { method: 'GET', url: `/runs/${id}` })).body)

describe('ingest', () => {
  it('stores steps once, uploads artifacts under the tenant prefix, and finishes the run', async () => {
    const { id, job, itemId } = await startRun()
    const uploads = await agent.upload(
      job.payload,
      itemId,
      { index: 0, id: 's1' },
      {
        'screenshot.png': Buffer.from('\x89PNG fake'),
        'tree.json': Buffer.from('[]'),
        'device.log': undefined,
      },
    )
    expect(uploads.map((u) => u.key)).toEqual([
      `${huynh.tenantId}/runs/${id}/${itemId}/0-s1/screenshot.png`,
      `${huynh.tenantId}/runs/${id}/${itemId}/0-s1/tree.json`,
    ])
    agent.step(job.payload, itemId, 0, 's1')
    agent.step(job.payload, itemId, 0, 's1', { duration_ms: 999 }) // duplicate: ignored
    agent.step(job.payload, itemId, 1, 's2', {
      status: 'failed',
      failure_code: 'EXPECT_FAILED',
      message: 'text "Products" is not visible',
    })
    agent.item(job.payload, itemId, 'failed', {
      failure_code: 'EXPECT_FAILED',
      failed_step_id: 's2',
    })
    agent.done(job.payload, 'passed') // the server trusts items: one failed → run failed
    await until(async () => (await getRun(id)).status !== 'running')

    const run = await getRun(id)
    expect(run).toMatchObject({
      status: 'failed',
      items: [{ status: 'failed', failure_code: 'EXPECT_FAILED', failed_step_id: 's2' }],
    })
    const stored = await server.db.select().from(runSteps).where(eq(runSteps.runItemId, itemId))
    expect(stored.map((s) => [s.stepIndex, s.durationMs])).toEqual([
      [0, 120],
      [1, 120],
    ])

    const steps = api.runStepSchema
      .array()
      .parse(
        (await server.call(huynh, { method: 'GET', url: `/runs/${id}/items/${itemId}/steps` }))
          .body,
      )
    expect(steps[1]).toMatchObject({ status: 'failed', failure_code: 'EXPECT_FAILED' })
    expect(steps[0]?.artifacts.log_url).toBeNull()
    expect(steps[1]?.artifacts.log_url).toContain('device.log')
    const shot = await fetch(steps[0]?.artifacts.screenshot_url ?? '')
    expect(shot.status).toBe(200)

    const lease = await server.releasedLease(id)
    expect(lease.releaseReason).toBe('done')
    const [device] = await server.db.select().from(devices).where(eq(devices.id, deviceId))
    expect(device?.status).toBe('idle')
  })

  it('ignores messages about runs the agent does not hold', async () => {
    const { id, job, itemId } = await startRun()
    const stranger = await server.newAgent(huynh, 'stranger')
    const other = await fakeAgent(server.url, stranger.token, { devices: [] })
    const sent = other.client.send('job.done', {
      run_id: id,
      status: 'passed',
      summary: { passed: 1, failed: 0, skipped: 0 },
    })
    expect((await other.client.next('error', sent.id)).payload).toMatchObject({
      code: 'unknown_run',
    })
    other.close()
    expect((await getRun(id)).status).toBe('running')
    agent.item(job.payload, itemId, 'passed')
    agent.done(job.payload, 'passed')
    await until(async () => (await getRun(id)).status === 'passed')
  })
})

describe('cancel', () => {
  it('cancels a running run through the agent, and refuses a finished one (409)', async () => {
    const { id, job } = await startRun()
    const res = await server.call(huynh, { method: 'POST', url: `/runs/${id}/cancel` })
    expect(res.status).toBe(202)
    const cancel = await agent.client.next('job.cancel')
    expect(cancel.payload).toMatchObject({ run_id: id })
    agent.done(job.payload, 'cancelled')
    await until(async () => (await getRun(id)).status === 'cancelled')
    expect((await getRun(id)).items[0]?.status).toBe('skipped')
    const lease = await server.releasedLease(id)
    expect(lease.releaseReason).toBe('cancelled')
    const audit = await server.db.select().from(auditLog).where(eq(auditLog.target, id))
    expect(audit.map((a) => a.action)).toContain('run.cancel')

    expect((await server.call(huynh, { method: 'POST', url: `/runs/${id}/cancel` })).status).toBe(
      409,
    )
  })
})

describe('read API', () => {
  it('lists runs newest first with a cursor, filtered by project and status', async () => {
    const page1 = await server.call(huynh, {
      method: 'GET',
      url: `/runs?project_id=${fixture.project.id}&limit=2`,
    })
    const body1 = page1.body as { items: api.Run[]; next_cursor: string | null }
    expect(body1.items).toHaveLength(2)
    expect(body1.next_cursor).toBe(body1.items[1]?.id)
    const page2 = await server.call(huynh, {
      method: 'GET',
      url: `/runs?project_id=${fixture.project.id}&limit=2&cursor=${body1.next_cursor}`,
    })
    const body2 = page2.body as { items: api.Run[] }
    expect(body2.items.every((r) => r.id < (body1.items[1]?.id ?? ''))).toBe(true)
    const cancelled = await server.call(huynh, { method: 'GET', url: '/runs?status=cancelled' })
    expect(
      (cancelled.body as { items: api.Run[] }).items.every((r) => r.status === 'cancelled'),
    ).toBe(true)
  })

  it('hides runs of other tenants', async () => {
    const other = await server.newUser('Other')
    const list = await server.call(other, { method: 'GET', url: '/runs' })
    expect((list.body as { items: unknown[] }).items).toEqual([])
    const mine = (await server.call(huynh, { method: 'GET', url: '/runs' })).body as {
      items: api.Run[]
    }
    const run = mine.items[0]
    expect((await server.call(other, { method: 'GET', url: `/runs/${run?.id}` })).status).toBe(404)
    const steps = `/runs/${run?.id}/items/${run?.items[0]?.id}/steps`
    expect((await server.call(other, { method: 'GET', url: steps })).status).toBe(404)
  })

  it('reports readiness without details', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})
