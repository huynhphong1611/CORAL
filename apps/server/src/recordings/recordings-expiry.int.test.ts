import { api, type protocol } from '@coral/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { devices, leases, recordings } from '../db/schema'
import { recordingStepKey } from '../storage/keys'
import { fakeAgent } from '../testing/fake-agent'
import { startRunServer, type RunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'
import { emulator } from '../testing/ws-client'

// US4 T043: recordings untouched for 7 days expire with their snapshots.
let server: RunServer
let huynh: TestUser
let fixture: Awaited<ReturnType<RunServer['seed']>>
let agent: Awaited<ReturnType<typeof fakeAgent>>
const deviceOf: Record<string, string> = {}

beforeAll(async () => {
  server = await startRunServer({ liveIdleMs: 600_000 })
  huynh = await server.newUser('Huynh')
  fixture = await server.seed(huynh)
  agent = await fakeAgent(server.url, fixture.agent.token, {
    devices: ['x1', 'x2'].map((u) => emulator(u)),
  })
  const rows = await server.db.select().from(devices).where(eq(devices.agentId, fixture.agent.id))
  for (const row of rows) deviceOf[row.udid] = row.id
})
afterAll(async () => {
  agent.close()
  await server.close()
})

/** Starts a recording; the fake agent uploads the first snapshot like a real one. */
async function start(udid: string): Promise<string> {
  const request = server.call(huynh, {
    method: 'POST',
    url: '/recordings',
    payload: {
      project_id: fixture.project.id,
      app_id: fixture.app.id,
      build_id: fixture.build.id,
      device_id: deviceOf[udid],
    },
  })
  const message = await agent.client.next('device.command')
  const payload = message.payload as protocol.Payload<'device.command'>
  if (payload.command.kind !== 'prepare') throw new Error('expected prepare')
  const { upload } = payload.command
  await fetch(upload.screen, {
    method: 'PUT',
    headers: { 'content-type': 'image/jpeg' },
    body: 'jpg',
  })
  await fetch(upload.tree, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '[]',
  })
  agent.client.send(
    'device.command_result',
    {
      command_id: payload.command_id,
      ok: true,
      result: { screen_width: 1080, screen_height: 2400 },
    },
    message.id,
  )
  const res = await request
  expect(res.status).toBe(201)
  return api.recordingSchema.parse(res.body).id
}

const ageOut = (id: string) =>
  server.db
    .update(recordings)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(recordings.id, id))

describe('recording cleanup (US4, T043)', () => {
  it('expires recordings past 7 days: device let go, snapshots removed; fresh ones stay', async () => {
    const stale = await start('x1')
    const fresh = await start('x2')
    const key = recordingStepKey(huynh.tenantId, stale, 1, 'screen.jpg')
    expect(await server.artifacts.size(key)).toBe(3)
    await ageOut(stale)

    // The job covers every tenant: other tests' rows may go too, so only ours are checked.
    expect(await server.recordings.expireOld()).toBeGreaterThanOrEqual(1)
    const statusOf = async (id: string) =>
      (await server.db.select().from(recordings).where(eq(recordings.id, id)))[0]?.status
    const [row] = await server.db.select().from(recordings).where(eq(recordings.id, stale))
    expect(row?.status).toBe('expired')
    const [lease] = await server.db
      .select()
      .from(leases)
      .where(eq(leases.holderRef, `recording:${stale}`))
    expect(lease?.releasedAt).not.toBeNull()
    expect(await server.artifacts.size(key)).toBeUndefined()
    expect(
      await server.artifacts.size(recordingStepKey(huynh.tenantId, fresh, 1, 'tree.json')),
    ).toBe(2)

    expect(await statusOf(fresh)).toBe('recording')

    // A stopped one that ages out goes too.
    await server.call(huynh, { method: 'POST', url: `/recordings/${fresh}/stop` })
    await ageOut(fresh)
    expect(await server.recordings.expireOld()).toBeGreaterThanOrEqual(1)
    const view = api.recordingSchema.parse(
      (await server.call(huynh, { method: 'GET', url: `/recordings/${fresh}` })).body,
    )
    expect(view.status).toBe('expired')
  })
})
