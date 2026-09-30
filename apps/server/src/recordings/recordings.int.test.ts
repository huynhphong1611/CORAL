import type { protocol } from '@coral/shared'
import { api, validateTestCaseSource, type Step } from '@coral/shared'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deviceCommands, devices, leases } from '../db/schema'
import { fakeAgent } from '../testing/fake-agent'
import { startRunServer, type RunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'
import { connectUi, type UiClient } from '../testing/ui-client'
import { emulator } from '../testing/ws-client'

// US4 server side (T041): recordings over REST, steps over /ws/ui through a scripted agent.
const IDLE_MS = 400
const USER = 'bob@example.com'
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
    secrets: { TEST_USER: USER, TEST_PASSWORD: 'pa55-w0rd-xyz' },
  })
  huynh = await server.newUser('Huynh')
  lan = await server.teammate(huynh, 'Lan', 'member')
  mai = await server.teammate(huynh, 'Mai', 'viewer')
  fixture = await server.seed(huynh)
  agent = await fakeAgent(server.url, fixture.agent.token, {
    devices: ['r1', 'r2', 'r3'].map((u) => emulator(u)),
  })
  const rows = await server.db.select().from(devices).where(eq(devices.agentId, fixture.agent.id))
  for (const row of rows) deviceOf[row.udid] = row.id
})
afterAll(async () => {
  for (const tab of tabs) tab.close()
  agent.close()
  await server.close()
})

type Command = protocol.Payload<'device.command'>

/** The fake agent answers the next device.command with `result` (or an error). */
async function answerNext(answer: { result?: unknown; error?: { code: string; message: string } }) {
  const message = await agent.client.next('device.command')
  const payload = message.payload as Command
  agent.client.send(
    'device.command_result',
    {
      command_id: payload.command_id,
      ok: answer.error === undefined,
      ...(answer.error ? { error: answer.error } : {}),
      ...(answer.result !== undefined ? { result: answer.result as Record<string, unknown> } : {}),
    },
    message.id,
  )
  return payload
}

const SIZE = { screen_width: 1080, screen_height: 2400 }

async function start(user: TestUser, udid: string) {
  const request = server.call(user, {
    method: 'POST',
    url: '/recordings',
    payload: {
      project_id: fixture.project.id,
      app_id: fixture.app.id,
      build_id: fixture.build.id,
      device_id: deviceOf[udid],
    },
  })
  const prepare = await answerNext({ result: SIZE })
  const res = await request
  return { res, prepare }
}

async function tab(user: TestUser) {
  const client = await connectUi(server.url)
  tabs.push(client)
  await client.auth(user.token)
  return client
}

/** Records one action: the tab sends it, the fake agent returns `result`. */
async function record(
  client: UiClient,
  recordingId: string,
  command: protocol.DeviceCommand,
  result: unknown,
) {
  const sent = client.send('live.command', { recording_id: recordingId, command, record: true })
  const payload = await answerNext({ result })
  const done = (await client.next('live.result', sent.id))
    .payload as protocol.UiPayload<'live.result'>
  return { payload, done }
}

describe('recordings (US4, T041)', () => {
  let recordingId = ''
  const client = () => tab(huynh)

  it('starts: takes the device, prepares a fresh app, records s1 launch', async () => {
    const { res, prepare } = await start(huynh, 'r1')
    expect(res.status).toBe(201)
    const recording = api.recordingSchema.parse(res.body)
    recordingId = recording.id
    expect(recording).toMatchObject({ status: 'recording', created_by: { name: 'Huynh' } })
    expect(recording.steps?.map((s) => s.step)).toEqual([{ id: 's1', action: 'launch' }])
    expect(recording.steps?.[0]?.urls.screen).toMatch(/^http/)
    const command = prepare.command
    if (command.kind !== 'prepare') throw new Error(`got ${command.kind}`)
    expect(command).toMatchObject({ package: 'com.example.app', app_state: 'fresh' })
    expect(command.build?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(command.popups_yaml).toContain('coral/popups@1')
    expect(command.upload.screen).toContain(`/recordings/${recordingId}/1/screen.jpg`)

    const view = await server.call(mai, { method: 'GET', url: '/devices' })
    const device = api.deviceViewSchema
      .array()
      .parse(view.body)
      .find((d) => d.udid === 'r1')
    expect(device?.activity).toMatchObject({ kind: 'recording', by: { name: 'Huynh' } })
    // Someone else cannot take it meanwhile.
    const busy = await server.call(lan, { method: 'POST', url: `/devices/${deviceOf.r1}/control` })
    expect(busy.status).toBe(409)
  })

  it('records a tap as step s2 and pushes it to the recorder’s tabs', async () => {
    const ui = await client()
    const agentStep: Step = {
      id: 'recorded',
      action: 'tap',
      target: [
        { android_id: 'id/menuIV' },
        { image: { path: 'snap/recording/recorded/element.png', screen_width: 1080 } },
      ],
    }
    const pushed = ui.next('recording.step')
    const { payload, done } = await record(
      ui,
      recordingId,
      { kind: 'tap', x: 79, y: 165 },
      {
        step: agentStep,
        suggestions: [{ visible_text: 'Log In' }],
        warnings: ['no_expect_after_tap'],
        ...SIZE,
      },
    )
    expect(done).toMatchObject({ ok: true })
    const command = payload.command
    if (command.kind !== 'record') throw new Error(`got ${command.kind}`)
    expect(command.action).toEqual({ kind: 'tap', x: 79, y: 165 })
    expect(command.upload.element).toContain(`/recordings/${recordingId}/2/element.png`)
    const step = ((await pushed).payload as protocol.UiPayload<'recording.step'>).step
    expect(step).toMatchObject({
      n: 2,
      step: {
        id: 's2',
        action: 'tap',
        target: [
          { android_id: 'id/menuIV' },
          { image: { path: 'snap/recording/s2/element.png', screen_width: 1080 } },
        ],
      },
      suggestions: [{ visible_text: 'Log In' }],
      snapshot: { element: expect.stringContaining('/2/element.png') as string },
    })
  })

  it('records text equal to a secret as the secret; only its name reaches the browser', async () => {
    const ui = await client()
    const pushed = ui.next('recording.step')
    const { payload } = await record(
      ui,
      recordingId,
      { kind: 'type', text: USER },
      {
        step: { id: 'recorded', action: 'type', value: '${secret:TEST_USER}' },
        suggestions: [],
        warnings: [],
        ...SIZE,
      },
    )
    const command = payload.command
    if (command.kind !== 'record' || command.action.kind !== 'type') throw new Error('not a type')
    expect(command.action).toMatchObject({ secret: 'TEST_USER', redact: [USER] })
    const message = (await pushed).payload as protocol.UiPayload<'recording.step'>
    expect(message.secret_hint).toEqual({ name: 'TEST_USER' })
    expect(message.step?.step).toMatchObject({ id: 's3', value: '${secret:TEST_USER}' })
    const rows = await server.db
      .select()
      .from(deviceCommands)
      .where(eq(deviceCommands.recordingId, recordingId))
    expect(JSON.stringify(rows)).not.toContain(USER)
  })

  it('tells about a tap a popup rule handles, without a step; inspects without touching', async () => {
    const ui = await client()
    const pushed = ui.next('recording.step')
    await record(
      ui,
      recordingId,
      { kind: 'tap', x: 500, y: 1100 },
      { suggestions: [], warnings: [], popup_rule: 'android_permission', ...SIZE },
    )
    expect(((await pushed).payload as protocol.UiPayload<'recording.step'>).popup_rule).toBe(
      'android_permission',
    )

    const sent = ui.send('live.inspect', { recording_id: recordingId, x: 100, y: 300 })
    const element = {
      ref: '0.1',
      platform_id: 'com.example.app:id/productTV',
      text: 'Products',
      desc: '',
      class: 'android.widget.TextView',
      bounds: { x: 40, y: 260, w: 600, h: 90 },
      clickable: false,
      enabled: true,
      visible: true,
      package_or_bundle: 'com.example.app',
      children: [],
    }
    const inspect = await answerNext({
      result: { element, locators: [{ android_id: 'id/productTV' }], text: 'Products' },
    })
    expect(inspect.command).toEqual({ kind: 'inspect', x: 100, y: 300 })
    const reply = await ui.next('live.inspected', sent.id)
    expect(reply.payload).toMatchObject({
      text: 'Products',
      locators: [{ android_id: 'id/productTV' }],
    })
  })

  it('edits steps, accepts a suggestion and previews valid YAML', async () => {
    const got = api.recordingSchema.parse(
      (await server.call(huynh, { method: 'GET', url: `/recordings/${recordingId}` })).body,
    )
    expect(got.steps?.map((s) => s.step.id)).toEqual(['s1', 's2', 's3'])
    const steps = (got.steps ?? []).map(({ urls: _urls, ...s }) =>
      s.n === 2
        ? { ...s, step: { ...s.step, expect: [{ visible_text: 'Log In' }] }, warnings: [] }
        : s,
    )
    const patched = await server.call(huynh, {
      method: 'PATCH',
      url: `/recordings/${recordingId}`,
      payload: { steps, intent: 'Mở menu rồi gõ tên đăng nhập', slug: 'recorded-login' },
    })
    expect(patched.status).toBe(200)
    const yaml = api.recordingYamlSchema.parse(
      (await server.call(huynh, { method: 'GET', url: `/recordings/${recordingId}/yaml` })).body,
    )
    const parsed = validateTestCaseSource(yaml.yaml, 'recorded-login.yaml')
    expect(parsed.valid).toBe(true)
    expect(yaml.yaml).toContain('snap/recorded-login/s2/element.png')
    expect(yaml.yaml).toContain('${secret:TEST_USER}')
    expect(yaml.yaml).not.toContain(USER)

    // A step may not point at another recording's objects.
    const stolen = steps.map((s) =>
      s.n === 2 ? { ...s, snapshot: { ...s.snapshot, screen: `${huynh.tenantId}/runs/x/y` } } : s,
    )
    const bad = await server.call(huynh, {
      method: 'PATCH',
      url: `/recordings/${recordingId}`,
      payload: { steps: stolen },
    })
    expect(bad.status).toBe(400)
  })

  it('keeps it to its tenant, its author, and writers', async () => {
    const other = await server.newUser('Other')
    expect(
      (await server.call(other, { method: 'GET', url: `/recordings/${recordingId}` })).status,
    ).toBe(404)
    const patch = {
      method: 'PATCH' as const,
      url: `/recordings/${recordingId}`,
      payload: { intent: 'x' },
    }
    expect((await server.call(mai, patch)).status).toBe(403)
    expect((await server.call(lan, patch)).status).toBe(403)
    const list = await server.call(mai, {
      method: 'GET',
      url: `/recordings?project_id=${fixture.project.id}`,
    })
    expect(
      api.recordingSchema
        .array()
        .parse(list.body)
        .map((r) => r.id),
    ).toContain(recordingId)
    // Another person's tab cannot record into it.
    const lansTab = await tab(lan)
    const sent = lansTab.send('live.command', {
      recording_id: recordingId,
      command: { kind: 'back' },
      record: true,
    })
    expect((await lansTab.next('live.result', sent.id)).payload).toMatchObject({
      ok: false,
      error: { code: 'not_holder' },
    })
  })

  it('stops, resumes and discards; the device follows', async () => {
    const stop = await server.call(huynh, {
      method: 'POST',
      url: `/recordings/${recordingId}/stop`,
    })
    expect(api.recordingSchema.parse(stop.body).status).toBe('stopped')
    const [lease] = await server.db
      .select()
      .from(leases)
      .where(and(eq(leases.holderRef, `recording:${recordingId}`)))
    expect(lease?.releasedAt).not.toBeNull()
    const resume = await server.call(huynh, {
      method: 'POST',
      url: `/recordings/${recordingId}/resume`,
    })
    expect(api.recordingSchema.parse(resume.body).status).toBe('recording')
    expect(
      (await server.call(huynh, { method: 'DELETE', url: `/recordings/${recordingId}` })).status,
    ).toBe(204)
    const gone = api.recordingSchema.parse(
      (await server.call(huynh, { method: 'GET', url: `/recordings/${recordingId}` })).body,
    )
    expect(gone.status).toBe('discarded')
  })

  it('takes over the recorder’s own control session; stops when idle (sweeper)', async () => {
    const control = await server.call(huynh, {
      method: 'POST',
      url: `/devices/${deviceOf.r2}/control`,
    })
    expect(control.status).toBe(201)
    const ui = await client()
    const ended = ui.next('live.ended')
    const { res } = await start(huynh, 'r2')
    expect(res.status).toBe(201)
    expect((await ended).payload).toMatchObject({ reason: 'replaced_by_recording' })
    const id = api.recordingSchema.parse(res.body).id

    await new Promise((r) => setTimeout(r, IDLE_MS + 100))
    const stopped = ui.next('live.ended')
    await server.sweeper.sweep()
    expect((await stopped).payload).toMatchObject({ recording_id: id, reason: 'idle_timeout' })
    const after = api.recordingSchema.parse(
      (await server.call(huynh, { method: 'GET', url: `/recordings/${id}` })).body,
    )
    expect(after.status).toBe('stopped')
  })

  it('refuses viewers and gives up cleanly when preparing fails', async () => {
    const viewer = await server.call(mai, {
      method: 'POST',
      url: '/recordings',
      payload: {
        project_id: fixture.project.id,
        app_id: fixture.app.id,
        build_id: fixture.build.id,
        device_id: deviceOf.r3,
      },
    })
    expect(viewer.status).toBe(403)
    const request = server.call(huynh, {
      method: 'POST',
      url: '/recordings',
      payload: {
        project_id: fixture.project.id,
        app_id: fixture.app.id,
        build_id: fixture.build.id,
        device_id: deviceOf.r3,
      },
    })
    await answerNext({ error: { code: 'command_failed', message: 'install failed' } })
    const res = await request
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: { code: 'prepare_failed' } })
    const devicesNow = api.deviceViewSchema
      .array()
      .parse((await server.call(huynh, { method: 'GET', url: '/devices' })).body)
    expect(devicesNow.find((d) => d.udid === 'r3')?.activity).toEqual({ kind: 'idle' })
  })
})
