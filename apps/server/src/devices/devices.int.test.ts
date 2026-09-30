import { api, newId } from '@coral/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { devices, leases, liveSessions, recordings } from '../db/schema'
import { fakeAgent } from '../testing/fake-agent'
import { startRunServer, type RunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'
import { emulator } from '../testing/ws-client'

let server: RunServer
let huynh: TestUser
let lan: TestUser
let fixture: Awaited<ReturnType<RunServer['seed']>>
let agent: Awaited<ReturnType<typeof fakeAgent>>
const idOf: Record<string, string> = {}

beforeAll(async () => {
  server = await startRunServer()
  huynh = await server.newUser('Huynh')
  lan = await server.teammate(huynh, 'Lan', 'member')
  fixture = await server.seed(huynh)
  agent = await fakeAgent(server.url, fixture.agent.token, {
    devices: ['run', 'live', 'recording', 'idle', 'gone'].map((u) => emulator(u)),
  })
  const rows = await server.db.select().from(devices).where(eq(devices.agentId, fixture.agent.id))
  for (const row of rows) idOf[row.udid] = row.id
})
afterAll(async () => {
  agent.close()
  await server.close()
})

const hourFromNow = () => new Date(Date.now() + 3_600_000)

async function openLease(udid: string, kind: 'live' | 'recording', holder: string) {
  const [lease] = await server.db
    .insert(leases)
    .values({
      tenantId: huynh.tenantId,
      deviceId: idOf[udid] ?? '',
      kind,
      holderRef: `${kind}:${holder}`,
      expiresAt: hourFromNow(),
    })
    .returning()
  await server.db
    .update(devices)
    .set({ status: 'leased' })
    .where(eq(devices.id, lease?.deviceId ?? ''))
  return lease?.id ?? ''
}

async function list(user: TestUser) {
  const res = await server.call(user, { method: 'GET', url: '/devices' })
  expect(res.status).toBe(200)
  return api.deviceViewSchema.array().parse(res.body)
}

describe('GET /devices activity (FR-003)', () => {
  it('says what each device is doing and who is behind it', async () => {
    const created = await server.call(huynh, {
      method: 'POST',
      url: '/runs',
      payload: {
        project_id: fixture.project.id,
        build_id: fixture.build.id,
        device_id: idOf.run,
        test_case_ids: [fixture.testCase.id],
      },
    })
    const runId = (created.body as { id: string }).id
    agent.ack(await agent.nextJob())

    const liveId = newId()
    const liveLease = await openLease('live', 'live', liveId)
    await server.db.insert(liveSessions).values({
      id: liveId,
      tenantId: huynh.tenantId,
      deviceId: idOf.live ?? '',
      userId: lan.userId,
      leaseId: liveLease,
    })
    const recordingId = newId()
    const recordingLease = await openLease('recording', 'recording', recordingId)
    await server.db.insert(recordings).values({
      id: recordingId,
      tenantId: huynh.tenantId,
      projectId: fixture.project.id,
      appId: fixture.app.id,
      buildId: fixture.build.id,
      deviceId: idOf.recording ?? '',
      userId: huynh.userId,
      leaseId: recordingLease,
      slug: 'draft',
      expiresAt: hourFromNow(),
    })
    await server.db
      .update(devices)
      .set({ status: 'offline' })
      .where(eq(devices.id, idOf.gone ?? ''))

    // Every role reads the devices page, a viewer too.
    const viewer = await server.teammate(huynh, 'Mai', 'viewer')
    const activity = Object.fromEntries((await list(viewer)).map((d) => [d.udid, d.activity]))
    expect(activity.run).toMatchObject({
      kind: 'run',
      run_id: runId,
      by: { user_id: huynh.userId, name: 'Huynh' },
    })
    expect(activity.live).toMatchObject({ kind: 'live', by: { user_id: lan.userId, name: 'Lan' } })
    expect(activity.recording).toMatchObject({
      kind: 'recording',
      by: { user_id: huynh.userId, name: 'Huynh' },
    })
    expect(activity.live?.run_id).toBeUndefined()
    for (const busy of [activity.run, activity.live, activity.recording]) {
      expect(Date.now() - Date.parse(busy?.since ?? '')).toBeLessThan(60_000)
    }
    expect(activity.idle).toEqual({ kind: 'idle' })
    expect(activity.gone).toEqual({ kind: 'offline' })
  })

  it('shows another tenant none of it', async () => {
    expect(await list(await server.newUser('Other'))).toEqual([])
  })
})
