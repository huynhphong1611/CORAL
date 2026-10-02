import { api, type protocol } from '@coral/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DeviceAgent } from '../testing/device-agent'
import { startRunServer, type RunServer } from '../testing/run-server'
import { sampleDevice, sampleProject } from '../testing/sample-project'
import type { TestUser } from '../testing/test-server'
import { connectUi, type UiClient } from '../testing/ui-client'

// US2 REST and /ws/ui (T033): explorations, the app map and the files of the project repo.
let server: RunServer
let huynh: TestUser
let mai: TestUser
let lan: TestUser
let fixture: Awaited<ReturnType<typeof sampleProject>>
const agents: DeviceAgent[] = []
const tabs: UiClient[] = []

beforeAll(async () => {
  server = await startRunServer({ explorer: { write: false } })
  huynh = await server.newUser('Huynh')
  mai = await server.teammate(huynh, 'Mai', 'viewer')
  lan = await server.newUser('Lan')
  fixture = await sampleProject(server, huynh)
})
afterAll(async () => {
  for (const tab of tabs) tab.close()
  for (const agent of agents) agent.close()
  await server.close()
})

async function device(udid: string) {
  const found = await sampleDevice(server, huynh, udid)
  agents.push(found.sample)
  return found.deviceId
}

async function tab(user: TestUser) {
  const client = await connectUi(server.url)
  tabs.push(client)
  await client.auth(user.token)
  return client
}

const get = (user: TestUser, url: string) => server.call(user, { method: 'GET', url })

async function finished(id: string, timeoutMs = 30_000): Promise<api.Exploration> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = api.explorationSchema.parse((await get(huynh, `/explorations/${id}`)).body)
    if (!['queued', 'running', 'writing'].includes(row.status)) return row
    if (Date.now() > deadline) throw new Error(`exploration still ${row.status}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('exploration routes (US2, T033)', { timeout: 60_000 }, () => {
  let explorationId = ''

  it('starts an exploration for writers only, with the default budget', async () => {
    const deviceId = await device('routes-1')
    const body = {
      project_id: fixture.project.id,
      app_id: fixture.app.id,
      build_id: fixture.build.id,
      device_id: deviceId,
      budget: { max_steps: 8 },
    }
    const refused = await server.call(mai, { method: 'POST', url: '/explorations', payload: body })
    expect(refused.status).toBe(403)
    const invalid = await server.call(huynh, {
      method: 'POST',
      url: '/explorations',
      payload: { ...body, budget: { max_steps: 501 } },
    })
    expect(invalid.status).toBe(400)

    const watcher = await tab(huynh)
    const res = await server.call(huynh, { method: 'POST', url: '/explorations', payload: body })
    expect(res.status).toBe(201)
    const created = api.explorationSchema.parse(res.body)
    explorationId = created.id
    expect(created).toMatchObject({
      kind: 'explore',
      budget: { max_steps: 8, max_depth: 8, max_minutes: 20, max_cost_usd: 3 },
      created_by: { id: huynh.userId },
    })

    // The tab follows it: the state now, then each step as the Explorer stores it.
    watcher.send('exploration.watch', { exploration_id: created.id })
    const first = await watcher.next('exploration.updated', undefined, 10_000)
    expect(first.payload).toMatchObject({ exploration_id: created.id })
    const step = (await watcher.next('exploration.step', undefined, 10_000))
      .payload as protocol.UiPayload<'exploration.step'>
    expect(step.step.n).toBeGreaterThan(0)
    expect(step.step.screenshot_url).toMatch(/^http/)

    // The device shows who holds it while it runs.
    const devices = api.deviceViewSchema
      .array()
      .parse((await get(huynh, '/devices')).body)
      .find((d) => d.id === deviceId)
    expect(devices?.activity).toMatchObject({ kind: 'exploration', exploration_id: created.id })

    const done = await finished(created.id)
    expect(done).toMatchObject({ status: 'done', stop_reason: 'max_steps' })
    const last = watcher.received.filter((m) => m.type === 'exploration.updated').at(-1)
    expect(last?.payload).toMatchObject({ status: 'done', stop_reason: 'max_steps' })
  })

  it('lists, details and pages the trace; another tenant sees nothing', async () => {
    const list = api.explorationSchema
      .array()
      .parse((await get(huynh, `/explorations?project_id=${fixture.project.id}`)).body)
    expect(list.map((e) => e.id)).toContain(explorationId)
    expect((await get(huynh, '/explorations?status=nonsense')).status).toBe(400)

    const detail = api.explorationDetailSchema.parse(
      (await get(huynh, `/explorations/${explorationId}`)).body,
    )
    expect(detail.appmap.screens.length).toBe(detail.stats.screens)
    expect(detail.appmap.screens[0]).toMatchObject({ is_new: true, screenshot_url: /^http/ })
    expect(detail.appmap.transitions.length).toBe(detail.stats.transitions)
    expect(detail).toMatchObject({ test_cases: [], findings: [] })

    const page = api.explorationStepSchema
      .array()
      .parse((await get(huynh, `/explorations/${explorationId}/steps?limit=5`)).body)
    expect(page.map((s) => s.n)).toEqual([1, 2, 3, 4, 5])
    expect(page[0]?.screen.name).toEqual(expect.any(String))
    const rest = api.explorationStepSchema
      .array()
      .parse((await get(huynh, `/explorations/${explorationId}/steps?after=5`)).body)
    expect(rest.map((s) => s.n)).toEqual([6, 7, 8])

    // What the AI saw and answered for a step (FR-006a): its picture as a presigned URL.
    const callId = page[0]?.brain_call_id ?? ''
    const call = api.brainCallSchema.parse((await get(mai, `/brain-calls/${callId}`)).body)
    expect(call).toMatchObject({ role: 'explorer', provider: 'fake', ok: true })
    expect(call.content?.messages[0]?.image).toMatch(/^http.*ai\.jpg/)
    expect(call.content?.decision).toEqual(page[0]?.decision)

    for (const url of [
      `/brain-calls/${callId}`,
      `/explorations/${explorationId}`,
      `/explorations/${explorationId}/steps`,
      `/projects/${fixture.project.id}/appmap`,
    ]) {
      expect((await get(lan, url)).status).toBe(404)
    }
    expect(
      (await server.call(lan, { method: 'POST', url: `/explorations/${explorationId}/stop` }))
        .status,
    ).toBe(404)
    const other = await tab(lan)
    const watch = other.send('exploration.watch', { exploration_id: explorationId })
    expect((await other.next('error', watch.id)).payload).toMatchObject({ code: 'not_found' })
  })

  it('serves the app map at head and only appmap/snap/ and imports/ files', async () => {
    const map = api.projectAppMapSchema.parse(
      (await get(mai, `/projects/${fixture.project.id}/appmap`)).body,
    )
    expect(map.screens.length).toBeGreaterThan(0)
    const screen = map.screens[0]
    expect(screen?.screenshot_url).toBe(
      `/projects/${fixture.project.id}/files/appmap/snap/${screen?.id}/screen.jpg?commit=${map.head_commit}`,
    )
    const picture = await get(mai, screen?.screenshot_url ?? '')
    expect(picture.status).toBe(200)
    expect(picture.res.headers['content-type']).toBe('image/jpeg')
    expect(picture.res.headers['cache-control']).toContain('immutable')
    const tree = await get(
      mai,
      `/projects/${fixture.project.id}/files/appmap/snap/${screen?.id}/tree.json`,
    )
    expect(tree.status).toBe(200)
    expect(tree.res.headers['cache-control']).toBe('private, no-cache')

    for (const path of [
      'popups.yaml',
      'appmap/screens.json',
      'appmap/snap',
      'appmap/snap/../../popups.yaml',
      'appmap/snap//x/screen.jpg',
      'imports',
    ]) {
      expect((await get(mai, `/projects/${fixture.project.id}/files/${path}`)).status).toBe(404)
    }

    const empty = await sampleProject(server, huynh)
    expect((await get(huynh, `/projects/${empty.project.id}/appmap`)).body).toMatchObject({
      schema: 'coral/appmap@1',
      screens: [],
      transitions: [],
    })
  })

  it('stops a running exploration (writers only) within 15 s', async () => {
    const deviceId = await device('routes-2')
    const res = await server.call(huynh, {
      method: 'POST',
      url: '/explorations',
      payload: {
        project_id: fixture.project.id,
        app_id: fixture.app.id,
        build_id: fixture.build.id,
        device_id: deviceId,
        budget: { max_steps: 400 },
      },
    })
    const created = api.explorationSchema.parse(res.body)
    const busy = await server.call(huynh, {
      method: 'POST',
      url: '/explorations',
      payload: {
        project_id: fixture.project.id,
        app_id: fixture.app.id,
        build_id: fixture.build.id,
        device_id: deviceId,
      },
    })
    expect(busy.status).toBe(409)
    expect(busy.body).toMatchObject({ error: { code: 'device_busy' } })

    const viewer = await server.call(mai, {
      method: 'POST',
      url: `/explorations/${created.id}/stop`,
    })
    expect(viewer.status).toBe(403)
    const asked = Date.now()
    const stopped = await server.call(huynh, {
      method: 'POST',
      url: `/explorations/${created.id}/stop`,
    })
    expect(Date.now() - asked).toBeLessThan(15_000)
    expect(stopped.status).toBe(202)
    expect(stopped.body).toMatchObject({ status: 'stopped', stop_reason: 'user_stopped' })
  })
})

describe('without AI configured', { timeout: 60_000 }, () => {
  it('answers 409 brains_not_configured', async () => {
    const bare = await startRunServer({ explorer: { platformBrains: false, write: false } })
    try {
      const owner = await bare.newUser('Huynh')
      const project = await sampleProject(bare, owner)
      const found = await sampleDevice(bare, owner, 'routes-3')
      agents.push(found.sample)
      const res = await bare.call(owner, {
        method: 'POST',
        url: '/explorations',
        payload: {
          project_id: project.project.id,
          app_id: project.app.id,
          build_id: project.build.id,
          device_id: found.deviceId,
        },
      })
      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({ error: { code: 'brains_not_configured' } })
    } finally {
      await bare.close()
    }
  })
})
