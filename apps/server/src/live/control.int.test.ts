import { api, type protocol } from '@coral/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLog, deviceCommands, devices } from '../db/schema'
import { fakeAgent } from '../testing/fake-agent'
import { startRunServer, type RunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'
import { connectUi, type UiClient } from '../testing/ui-client'
import type { ReceivedMessage } from '../testing/ws-client'
import { emulator } from '../testing/ws-client'

const IDLE_MS = 400
let server: RunServer
let huynh: TestUser
let lan: TestUser
let mai: TestUser
let fixture: Awaited<ReturnType<RunServer['seed']>>
let agent: Awaited<ReturnType<typeof fakeAgent>>
const deviceOf: Record<string, string> = {}
const tabs: UiClient[] = []

beforeAll(async () => {
  server = await startRunServer({
    liveIdleMs: IDLE_MS,
    secrets: { TEST_USER: 'bob@example.com', TEST_PASSWORD: 'pa55-w0rd-xyz' },
  })
  huynh = await server.newUser('Huynh')
  lan = await server.teammate(huynh, 'Lan', 'member')
  mai = await server.teammate(huynh, 'Mai', 'viewer')
  fixture = await server.seed(huynh)
  agent = await fakeAgent(server.url, fixture.agent.token, {
    devices: ['a', 'b', 'c', 'd', 'e'].map((u) => emulator(u)),
  })
  const rows = await server.db.select().from(devices).where(eq(devices.agentId, fixture.agent.id))
  for (const row of rows) deviceOf[row.udid] = row.id
})
afterAll(async () => {
  for (const tab of tabs) tab.close()
  agent.close()
  await server.close()
})

const control = (user: TestUser, method: 'POST' | 'GET' | 'DELETE', udid: string) =>
  server.call(user, { method, url: `/devices/${deviceOf[udid] ?? udid}/control` })

async function take(user: TestUser, udid: string) {
  const res = await control(user, 'POST', udid)
  expect(res.status).toBe(201)
  return api.controlSessionSchema.parse(res.body)
}

async function tab(user: TestUser) {
  const client = await connectUi(server.url)
  tabs.push(client)
  await client.auth(user.token)
  return client
}

/** The fake agent answers the next device.command it gets. */
async function answerNext(result: Partial<protocol.Payload<'device.command_result'>> = {}) {
  const message = await agent.client.next('device.command')
  const payload = message.payload as protocol.Payload<'device.command'>
  agent.client.send(
    'device.command_result',
    { command_id: payload.command_id, ok: true, ...result },
    message.id,
  )
  return payload
}

async function command(client: UiClient, sessionId: string, cmd: protocol.DeviceCommand) {
  const sent = client.send('live.command', { live_session_id: sessionId, command: cmd })
  return (await client.next('live.result', sent.id)).payload as protocol.UiPayload<'live.result'>
}

const activityOf = async (user: TestUser, udid: string) =>
  api.deviceViewSchema
    .array()
    .parse((await server.call(user, { method: 'GET', url: '/devices' })).body)
    .find((d) => d.udid === udid)?.activity

describe('live control (US3, T032)', () => {
  it('lets one person hold a device; others see who and are refused (SC-006)', async () => {
    const session = await take(huynh, 'a')
    expect(session).toMatchObject({
      device_id: deviceOf.a,
      user: { id: huynh.userId, name: 'Huynh' },
      idle_timeout_ms: IDLE_MS,
    })
    expect(api.controlSessionSchema.parse((await control(mai, 'GET', 'a')).body)).toEqual(session)
    expect(await activityOf(mai, 'a')).toMatchObject({ kind: 'live', by: { name: 'Huynh' } })

    const busy = await control(lan, 'POST', 'a')
    expect(busy.status).toBe(409)
    expect(api.deviceBusyErrorSchema.parse(busy.body).error.activity).toMatchObject({
      kind: 'live',
      by: { user_id: huynh.userId },
    })
    // Only the holder lets go.
    expect((await control(lan, 'DELETE', 'a')).status).toBe(403)
    expect((await control(huynh, 'DELETE', 'a')).status).toBe(204)
    expect((await control(huynh, 'GET', 'a')).status).toBe(404)
    expect(await activityOf(huynh, 'a')).toEqual({ kind: 'idle' })
  })

  it('gives the device to exactly one of two people pressing at once', async () => {
    const [one, two] = await Promise.all([control(huynh, 'POST', 'b'), control(lan, 'POST', 'b')])
    expect([one.status, two.status].sort()).toEqual([201, 409])
    const winner = one.status === 201 ? huynh : lan
    expect((await control(winner, 'DELETE', 'b')).status).toBe(204)
  })

  it('refuses viewers, other tenants, and a device that is running a job', async () => {
    expect((await control(mai, 'POST', 'c')).status).toBe(403)
    const other = await server.newUser('Other')
    expect((await control(other, 'POST', 'c')).status).toBe(404)
    expect((await control(other, 'GET', 'c')).status).toBe(404)

    const run = await server.call(huynh, {
      method: 'POST',
      url: '/runs',
      payload: {
        project_id: fixture.project.id,
        build_id: fixture.build.id,
        device_id: deviceOf.c,
        test_case_ids: [fixture.testCase.id],
      },
    })
    const job = await agent.nextJob()
    const busy = await control(huynh, 'POST', 'c')
    expect(busy.status).toBe(409)
    expect(api.deviceBusyErrorSchema.parse(busy.body).error.activity).toMatchObject({
      kind: 'run',
      run_id: (run.body as { id: string }).id,
    })
    agent.ack(job)
    agent.done(job.payload, 'cancelled')
    await server.releasedLease((run.body as { id: string }).id)
  })

  it('sends the holder’s commands to the device and records them without the text typed', async () => {
    const session = await take(huynh, 'd')
    const holder = await tab(huynh)

    const tap = command(holder, session.live_session_id, { kind: 'tap', x: 540, y: 1200 })
    expect(await answerNext()).toMatchObject({
      udid: 'd',
      command: { kind: 'tap', x: 540, y: 1200 },
    })
    expect(await tap).toMatchObject({ ok: true })

    const typed = command(holder, session.live_session_id, { kind: 'type', text: 'Nguyễn Văn A' })
    expect((await answerNext()).command).toEqual({ kind: 'type', text: 'Nguyễn Văn A', redact: [] })
    expect(await typed).toMatchObject({ ok: true })

    // A secret: the server fills in the value, the browser only named it.
    const secret = command(holder, session.live_session_id, {
      kind: 'type',
      secret: 'TEST_PASSWORD',
    })
    expect((await answerNext()).command).toEqual({
      kind: 'type',
      text: 'pa55-w0rd-xyz',
      redact: ['pa55-w0rd-xyz'],
      secret: 'TEST_PASSWORD',
    })
    expect(await secret).toMatchObject({ ok: true })
    expect(
      await command(holder, session.live_session_id, { kind: 'type', secret: 'NOPE' }),
    ).toMatchObject({ ok: false, error: { code: 'missing_secret' } })

    // The device's failure comes back as it is.
    const back = command(holder, session.live_session_id, { kind: 'back' })
    await answerNext({ ok: false, error: { code: 'command_failed', message: 'u2 died' } })
    expect(await back).toMatchObject({ ok: false, error: { code: 'command_failed' } })

    const rows = await server.db
      .select()
      .from(deviceCommands)
      .where(eq(deviceCommands.liveSessionId, session.live_session_id))
    expect(rows.map((r) => [r.kind, r.params, r.status])).toEqual([
      ['tap', { x: 540, y: 1200 }, 'ok'],
      ['type', { length: 12 }, 'ok'],
      ['type', { secret: 'TEST_PASSWORD' }, 'ok'],
      ['back', {}, 'failed'],
    ])
    const stored = JSON.stringify([rows, await server.db.select().from(auditLog)])
    expect(stored).not.toContain('Nguyễn')
    expect(stored).not.toContain('pa55-w0rd-xyz')
    // Anyone else's command is refused before it reaches the device.
    const teammate = await tab(lan)
    expect(await command(teammate, session.live_session_id, { kind: 'back' })).toMatchObject({
      ok: false,
      error: { code: 'not_holder' },
    })
    const outsider = await tab(await server.newUser('Other'))
    expect(await command(outsider, session.live_session_id, { kind: 'back' })).toMatchObject({
      ok: false,
      error: { code: 'not_holder' },
    })
    const viewer = await tab(mai)
    expect(await command(viewer, session.live_session_id, { kind: 'back' })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    })
    expect(agent.client.received.filter((m) => m.type === 'device.command')).toEqual([])
    expect((await control(huynh, 'DELETE', 'd')).status).toBe(204)
    expect((await command(holder, session.live_session_id, { kind: 'back' })).error?.code).toBe(
      'session_ended',
    )
    const audit = await server.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, deviceOf.d ?? ''))
    expect(audit.map((a) => a.action)).toEqual(['device.control', 'device.release'])
  })

  it('makes a run wait while the device is held and starts it once released', async () => {
    await take(lan, 'e')
    const created = await server.call(huynh, {
      method: 'POST',
      url: '/runs',
      payload: {
        project_id: fixture.project.id,
        build_id: fixture.build.id,
        device_id: deviceOf.e,
        test_case_ids: [fixture.testCase.id],
      },
    })
    const runId = (created.body as { id: string }).id
    await new Promise((r) => setTimeout(r, 300))
    expect(agent.client.received.filter((m) => m.type === 'job.assign')).toEqual([])
    const run = await server.call(huynh, { method: 'GET', url: `/runs/${runId}` })
    expect((run.body as api.Run).status).toBe('queued')
    expect((await control(lan, 'DELETE', 'e')).status).toBe(204)
    const job = await agent.nextJob()
    expect(job.payload.run_id).toBe(runId)
    agent.ack(job)
    agent.done(job.payload, 'cancelled')
    await server.releasedLease(runId)
  })

  it('lets go after the idle time and tells the holder (sweeper)', async () => {
    const session = await take(huynh, 'a')
    const holder = await tab(huynh)
    const bystander = await tab(lan)
    // A command keeps it alive…
    await new Promise((r) => setTimeout(r, IDLE_MS / 2))
    const tap = command(holder, session.live_session_id, { kind: 'tap', x: 1, y: 1 })
    await answerNext()
    await tap
    await new Promise((r) => setTimeout(r, IDLE_MS / 2 + 50))
    await server.sweeper.sweep()
    expect((await control(huynh, 'GET', 'a')).status).toBe(200)
    // …then nothing for longer than the idle time.
    await new Promise((r) => setTimeout(r, IDLE_MS + 50))
    await server.sweeper.sweep()
    const ended = await holder.next('live.ended')
    expect(ended.payload).toEqual({
      live_session_id: session.live_session_id,
      reason: 'idle_timeout',
    })
    expect((await control(huynh, 'GET', 'a')).status).toBe(404)
    expect(await activityOf(huynh, 'a')).toEqual({ kind: 'idle' })
    expect(bystander.received.filter((m: ReceivedMessage) => m.type === 'live.ended')).toEqual([])
  })

  it('ends the session when the agent goes away', async () => {
    const laptop = await server.newAgent(huynh, 'laptop-2')
    const other = await fakeAgent(server.url, laptop.token, { devices: [emulator('z')] })
    const [row] = await server.db.select().from(devices).where(eq(devices.agentId, laptop.id))
    deviceOf.z = row?.id ?? ''
    const session = await take(huynh, 'z')
    const holder = await tab(huynh)
    other.close()
    const ended = await holder.next('live.ended')
    expect(ended.payload).toEqual({
      live_session_id: session.live_session_id,
      reason: 'agent_offline',
    })
    expect((await control(huynh, 'POST', 'z')).status).toBe(409)
  })
})
