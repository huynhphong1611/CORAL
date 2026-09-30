import { api, type protocol, type Step } from '@coral/shared'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { devices, testCases } from '../db/schema'
import { fakeAgent } from '../testing/fake-agent'
import { startRunServer, type RunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'
import { connectUi, type UiClient } from '../testing/ui-client'
import { emulator } from '../testing/ws-client'

// US4 T042: a recording saved as a test case — YAML + snap/<slug>/ in one commit.
let server: RunServer
let huynh: TestUser
let fixture: Awaited<ReturnType<RunServer['seed']>>
let agent: Awaited<ReturnType<typeof fakeAgent>>
let ui: UiClient
const deviceOf: Record<string, string> = {}
const SIZE = { screen_width: 1080, screen_height: 2400 }
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7])

beforeAll(async () => {
  server = await startRunServer({ liveIdleMs: 600_000 })
  huynh = await server.newUser('Huynh')
  fixture = await server.seed(huynh)
  agent = await fakeAgent(server.url, fixture.agent.token, {
    devices: ['s1', 's2'].map((u) => emulator(u)),
  })
  const rows = await server.db.select().from(devices).where(eq(devices.agentId, fixture.agent.id))
  for (const row of rows) deviceOf[row.udid] = row.id
  ui = await connectUi(server.url)
  await ui.auth(huynh.token)
})
afterAll(async () => {
  ui.close()
  agent.close()
  await server.close()
})

type Command = protocol.Payload<'device.command'>

/** Answers the next command like the agent: uploads the snapshot it was given, then the result. */
async function answerNext(result: Record<string, unknown>) {
  const message = await agent.client.next('device.command')
  const payload = message.payload as Command
  const { command } = payload
  if (command.kind === 'prepare' || command.kind === 'record') {
    const put = (url: string, body: Buffer | string, type: string) =>
      fetch(url, { method: 'PUT', headers: { 'content-type': type }, body })
    await put(command.upload.screen, JPEG, 'image/jpeg')
    await put(
      command.upload.tree,
      JSON.stringify([{ ref: '0', text: 'Products' }]),
      'application/json',
    )
    if (command.kind === 'record') await put(command.upload.element, PNG, 'image/png')
  }
  agent.client.send(
    'device.command_result',
    { command_id: payload.command_id, ok: true, result },
    message.id,
  )
}

async function startRecording(udid: string): Promise<string> {
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
  await answerNext(SIZE)
  const res = await request
  expect(res.status).toBe(201)
  return api.recordingSchema.parse(res.body).id
}

async function recordTap(recordingId: string, text: string) {
  const step: Step = {
    id: 'recorded',
    action: 'tap',
    target: [
      { text },
      { image: { path: 'snap/recording/recorded/element.png', screen_width: 1080 } },
    ],
  }
  const sent = ui.send('live.command', {
    recording_id: recordingId,
    command: { kind: 'tap', x: 10, y: 10 },
    record: true,
  })
  await answerNext({ step, suggestions: [{ visible_text: 'Log In' }], warnings: [], ...SIZE })
  expect((await ui.next('live.result', sent.id)).payload).toMatchObject({ ok: true })
}

async function preview(recordingId: string, slug: string, intent: string) {
  await server.call(huynh, {
    method: 'PATCH',
    url: `/recordings/${recordingId}`,
    payload: { slug, intent },
  })
  return api.recordingYamlSchema.parse(
    (await server.call(huynh, { method: 'GET', url: `/recordings/${recordingId}/yaml` })).body,
  ).yaml
}

const save = (recordingId: string, payload: Record<string, unknown>) =>
  server.call(huynh, { method: 'POST', url: `/recordings/${recordingId}/save`, payload })

const repoFiles = (commit: string) =>
  server.store.listFiles(huynh.tenantId, fixture.project.id, 'snap/recorded-login', commit)

describe('saving a recording (US4, T042)', () => {
  let first = ''
  let saved: api.SavedRecording

  it('refuses invalid YAML or a missing image and commits nothing', async () => {
    first = await startRecording('s1')
    await recordTap(first, 'Menu')
    const yaml = await preview(first, 'recorded-login', 'Mở menu')

    const broken = await save(first, {
      slug: 'recorded-login',
      intent: 'Mở menu',
      yaml: yaml.replace('action: tap', 'action: fly'),
    })
    expect(broken.status).toBe(400)
    expect(broken.body).toMatchObject({ error: { code: 'validation_failed' } })

    const missing = await save(first, {
      slug: 'recorded-login',
      intent: 'Mở menu',
      yaml: yaml.replace(
        'snap/recorded-login/s2/element.png',
        'snap/recorded-login/s9/element.png',
      ),
    })
    expect(missing.status).toBe(400)
    expect(JSON.stringify(missing.body)).toContain('image_not_found')

    const rows = await server.db
      .select()
      .from(testCases)
      .where(and(eq(testCases.projectId, fixture.project.id), eq(testCases.slug, 'recorded-login')))
    expect(rows).toEqual([])
  })

  it('commits the YAML and every snapshot together, source recorder, within 2 s (SC-009)', async () => {
    const yaml = await preview(first, 'recorded-login', 'Mở menu')
    const started = Date.now()
    const res = await save(first, { slug: 'recorded-login', intent: 'Mở menu', yaml })
    const ms = Date.now() - started
    expect(res.status).toBe(201)
    expect(ms).toBeLessThan(2000)
    saved = api.savedRecordingSchema.parse(res.body)

    expect(await repoFiles(saved.head_commit)).toEqual([
      'snap/recorded-login/s1/screen.jpg',
      'snap/recorded-login/s1/tree.json',
      'snap/recorded-login/s2/element.png',
      'snap/recorded-login/s2/screen.jpg',
      'snap/recorded-login/s2/tree.json',
    ])
    const { store } = server
    const at = (path: string) =>
      store.readBytes(huynh.tenantId, fixture.project.id, path, saved.head_commit)
    expect(await at('snap/recorded-login/s2/element.png')).toEqual(PNG)
    expect(await at('snap/recorded-login/s1/screen.jpg')).toEqual(JPEG)
    // One commit: the YAML and a snapshot share it.
    const yamlHistory = await store.history(
      huynh.tenantId,
      fixture.project.id,
      'testcases/recorded-login.yaml',
    )
    const snapHistory = await store.history(
      huynh.tenantId,
      fixture.project.id,
      'snap/recorded-login/s2/element.png',
    )
    expect(yamlHistory.map((v) => v.commit)).toEqual([saved.head_commit])
    expect(snapHistory.map((v) => v.commit)).toEqual([saved.head_commit])
    expect(yamlHistory[0]?.author.name).toBe('Huynh')

    const testCase = api.testCaseDetailSchema.parse(
      (await server.call(huynh, { method: 'GET', url: `/testcases/${saved.test_case_id}` })).body,
    )
    expect(testCase).toMatchObject({ slug: 'recorded-login', source: 'recorder' })
    const recording = api.recordingSchema.parse(
      (await server.call(huynh, { method: 'GET', url: `/recordings/${first}` })).body,
    )
    expect(recording).toMatchObject({ status: 'saved', test_case_id: saved.test_case_id })
    const view = api.deviceViewSchema
      .array()
      .parse((await server.call(huynh, { method: 'GET', url: '/devices' })).body)
    expect(view.find((d) => d.udid === 's1')?.activity).toEqual({ kind: 'idle' })
  })

  it('refuses the same slug again unless replacing the current head; replaces snap/ as a whole', async () => {
    const again = await startRecording('s2')
    await recordTap(again, 'Catalog')
    await recordTap(again, 'Log In')
    const yaml = await preview(again, 'recorded-login', 'Mở menu rồi đăng nhập')
    const input = { slug: 'recorded-login', intent: 'Mở menu rồi đăng nhập', yaml }

    const taken = await save(again, input)
    expect(taken.status).toBe(409)
    expect(taken.body).toMatchObject({
      error: { code: 'slug_exists', test_case_id: saved.test_case_id },
    })
    const stale = await save(again, { ...input, replace: true, base_commit: 'a'.repeat(40) })
    expect(stale.status).toBe(409)

    const replaced = await save(again, { ...input, replace: true, base_commit: saved.head_commit })
    expect(replaced.status).toBe(201)
    const second = api.savedRecordingSchema.parse(replaced.body)
    expect(second.test_case_id).toBe(saved.test_case_id)
    expect(await repoFiles(second.head_commit)).toEqual([
      'snap/recorded-login/s1/screen.jpg',
      'snap/recorded-login/s1/tree.json',
      'snap/recorded-login/s2/element.png',
      'snap/recorded-login/s2/screen.jpg',
      'snap/recorded-login/s2/tree.json',
      'snap/recorded-login/s3/element.png',
      'snap/recorded-login/s3/screen.jpg',
      'snap/recorded-login/s3/tree.json',
    ])
    // The first version is still in the history.
    expect(await repoFiles(saved.head_commit)).toHaveLength(5)
  })
})
