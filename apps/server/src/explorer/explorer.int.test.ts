import { randomBytes } from 'node:crypto'
import { PLACE_ORDER, SAMPLE_APP } from '@coral/runner/testing'
import { api, newId, type Step } from '@coral/shared'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { devices, leases } from '../db/schema'
import { explorationHolder, explorationsRepo, type ExplorationRow } from '../repos/explorations'
import { explorationStepKey } from '../storage/keys'
import { deviceAgent, type DeviceAgent } from '../testing/device-agent'
import { multipart } from '../testing/multipart'
import { startRunServer, type RunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'
import { APPMAP_PATH, parseAppMap } from './appmap'

// US2 server side (T032): the Explorer on the fake sample app, with the `fake` brain.
let server: RunServer
let huynh: TestUser
const agents: DeviceAgent[] = []

beforeAll(async () => {
  server = await startRunServer({ explorer: { maxPerTenant: 1 } })
  huynh = await server.newUser('Huynh')
})
afterAll(async () => {
  for (const agent of agents) agent.close()
  await server.close()
})

/** A project of the sample app whose popups.yaml puts Place Order in never_tap. */
async function sampleProject(user: TestUser) {
  const call = server.call
  const project = api.projectSchema.parse(
    (await call(user, { method: 'POST', url: '/projects', payload: { name: `p-${newId()}` } }))
      .body,
  )
  const app = api.appSchema.parse(
    (
      await call(user, {
        method: 'POST',
        url: `/projects/${project.id}/apps`,
        payload: { platform: 'android', package_or_bundle_id: SAMPLE_APP, name: 'My Demo App' },
      })
    ).body,
  )
  const build = api.buildSchema.parse(
    (
      await call(user, {
        method: 'POST',
        url: `/apps/${app.id}/builds`,
        ...multipart({ version: '1.0.0' }, { name: 'app.apk', data: randomBytes(2048) }),
      })
    ).body,
  )
  const popups = api.popupsFileSchema.parse(
    (await call(user, { method: 'GET', url: `/projects/${project.id}/popups` })).body,
  )
  const put = await call(user, {
    method: 'PUT',
    url: `/projects/${project.id}/popups`,
    payload: {
      yaml: popups.yaml.replace("never_tap: ['Mua',", `never_tap: ['${PLACE_ORDER}', 'Mua',`),
      base_commit: popups.head_commit,
    },
  })
  expect(put.status).toBe(200)
  return { project, app, build }
}

/** An agent whose device runs the sample app; returns the device id. */
async function device(user: TestUser, udid: string) {
  const agent = await server.newAgent(user, `agent-${newId()}`)
  const sample = await deviceAgent(server.url, agent.token, { udid })
  agents.push(sample)
  const [row] = await server.db
    .select()
    .from(devices)
    .where(and(eq(devices.agentId, agent.id), eq(devices.udid, udid)))
  if (!row) throw new Error('device not registered')
  return { sample, deviceId: row.id }
}

async function until(
  read: () => Promise<ExplorationRow>,
  done: (row: ExplorationRow) => boolean,
  timeoutMs = 30_000,
): Promise<ExplorationRow> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = await read()
    if (done(row)) return row
    if (Date.now() > deadline) throw new Error(`exploration still ${row.status}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

const ended = (row: ExplorationRow) => !['queued', 'running', 'writing'].includes(row.status)

async function leaseOf(explorationId: string) {
  const [lease] = await server.db
    .select()
    .from(leases)
    .where(eq(leases.holderRef, explorationHolder(explorationId)))
  return lease
}

const caller = (user: TestUser) => ({ tenantId: user.tenantId, userId: user.userId })

describe('Explorer (US2, T032)', { timeout: 60_000 }, () => {
  it('explores until max_steps, names screens, never touches never_tap, commits the app map', async () => {
    const { project, app, build } = await sampleProject(huynh)
    const { sample, deviceId } = await device(huynh, 'explore-1')
    const repo = explorationsRepo(server.db, huynh.tenantId)

    const started = await server.explorations.start(caller(huynh), {
      project_id: project.id,
      app_id: app.id,
      build_id: build.id,
      device_id: deviceId,
      budget: { max_steps: 12 },
    })
    expect(started).toMatchObject({
      kind: 'explore',
      max_tests: api.DEFAULT_MAX_TESTS,
      budget: { max_steps: 12, max_depth: 8, max_minutes: 20, max_cost_usd: 3 },
    })
    const row = await until(() => repo.get(started.id), ended)
    expect(row).toMatchObject({ status: 'done', stopReason: 'max_steps' })
    expect(row.stats.steps).toBe(12)
    expect(row.stats.cost_usd).toBeGreaterThan(0)

    // The app was prepared fresh, then every step looked before acting.
    expect(sample.commands[0]).toMatchObject({ kind: 'prepare', app_state: 'fresh' })
    expect(sample.commands.filter((c) => c.kind === 'observe')).toHaveLength(12)

    const steps = await repo.steps(started.id)
    expect(steps.map((s) => s.n)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
    const first = steps[0]
    expect(first).toMatchObject({ status: 'done', segment: 1 })
    expect(first?.decision).toMatchObject({ action: 'tap', element: 1 })
    expect((first?.step as Step).id).toBe('s1')
    expect(first?.brainCallId).toEqual(expect.any(String))

    // Screens named once each; the cart was reached and Place Order never offered nor tapped.
    expect(new Set(row.screens.map((s) => s.fingerprint)).size).toBe(row.screens.length)
    expect(new Set(row.screens.map((s) => s.id)).size).toBe(row.screens.length)
    // FakeDriver reports the fake screen as the activity: catalog → menu → … → cart.
    expect(row.screens.map((s) => s.activity)).toEqual(
      expect.arrayContaining(['.catalog', '.menu', '.cart']),
    )
    expect(row.screens[0]).toMatchObject({ name: 'MY DEMO APP', first_step: 1, is_new: true })
    expect(row.stats.screens).toBe(row.screens.length)
    const taps = sample.driver.calls.filter((c) => c.kind === 'tap')
    expect(taps.some((c) => c.kind === 'tap' && c.node?.text === PLACE_ORDER)).toBe(false)
    for (const step of steps) expect(JSON.stringify(step.step)).not.toContain(PLACE_ORDER)

    // The trace lives in S3 under the exploration; the AI saw a downscaled picture.
    const key = (n: number, file: 'screen.jpg' | 'ai.jpg' | 'tree.json' | 'step.json') =>
      explorationStepKey(huynh.tenantId, started.id, n, file)
    expect(await server.artifacts.getBytes(key(1, 'screen.jpg'))).toBeDefined()
    expect(await server.artifacts.getBytes(key(1, 'ai.jpg'))).toBeDefined()
    expect(await server.artifacts.getBytes(key(1, 'step.json'))).toBeDefined()

    // One app map commit: every screen, its picture, and the transitions between them.
    expect(row.appmapCommit).toMatch(/^[0-9a-f]{40}$/)
    const map = parseAppMap(
      (await server.store.readFile(huynh.tenantId, project.id, APPMAP_PATH, 'HEAD')) ?? null,
    )
    expect(map.screens.map((s) => s.fingerprint).sort()).toEqual(
      row.screens.map((s) => s.fingerprint).sort(),
    )
    expect(map.screens.every((s) => s.seen_in.includes(started.id))).toBe(true)
    expect(map.transitions.length).toBe(row.stats.transitions)
    expect(map.transitions.length).toBeGreaterThan(0)
    const snap = await server.store.readFile(
      huynh.tenantId,
      project.id,
      `appmap/snap/${map.screens[0]?.id}/tree.json`,
      'HEAD',
    )
    expect(snap).toContain(SAMPLE_APP)

    // The device is free again; the web was told about every step and screen.
    expect(await leaseOf(started.id)).toMatchObject({ releaseReason: 'done' })
    const events = server.emitted.filter(
      (e) => (e.payload as { exploration_id: string }).exploration_id === started.id,
    )
    expect(events.filter((e) => e.type === 'exploration.step')).toHaveLength(12)
    expect(events.filter((e) => e.type === 'exploration.screen')).toHaveLength(row.screens.length)
    expect(events.at(-1)).toMatchObject({
      type: 'exploration.updated',
      payload: { status: 'done', stop_reason: 'max_steps' },
    })
  })

  it('stops when the user asks, and lets one exploration run per tenant here', async () => {
    const { project, app, build } = await sampleProject(huynh)
    const { deviceId } = await device(huynh, 'explore-2')
    const other = await device(huynh, 'explore-3')
    const repo = explorationsRepo(server.db, huynh.tenantId)
    const input = { project_id: project.id, app_id: app.id, build_id: build.id }

    const started = await server.explorations.start(caller(huynh), {
      ...input,
      device_id: deviceId,
      budget: { max_steps: 400 },
    })
    await until(
      () => repo.get(started.id),
      (row) => row.stats.steps >= 2,
    )
    await expect(
      server.explorations.start(caller(huynh), { ...input, device_id: other.deviceId }),
    ).rejects.toMatchObject({ status: 409, code: 'too_many_explorations' })

    const asked = Date.now()
    const stopped = await server.explorations.stop(huynh.tenantId, started.id)
    expect(Date.now() - asked).toBeLessThan(15_000)
    expect(stopped).toMatchObject({ status: 'stopped', stop_reason: 'user_stopped' })
    expect(await leaseOf(started.id)).toMatchObject({ releaseReason: 'cancelled' })
    expect((await repo.get(started.id)).appmapCommit).toMatch(/^[0-9a-f]{40}$/)
  })

  it('ends with device_offline when the agent goes away, and lets the device go', async () => {
    const { project, app, build } = await sampleProject(huynh)
    const { sample, deviceId } = await device(huynh, 'explore-4')
    const repo = explorationsRepo(server.db, huynh.tenantId)
    const started = await server.explorations.start(caller(huynh), {
      project_id: project.id,
      app_id: app.id,
      build_id: build.id,
      device_id: deviceId,
      budget: { max_steps: 400 },
    })
    await until(
      () => repo.get(started.id),
      (row) => row.stats.steps >= 2,
    )
    sample.close()
    const row = await until(() => repo.get(started.id), ended)
    expect(row).toMatchObject({ status: 'done', stopReason: 'device_offline' })
    expect(await leaseOf(started.id)).toMatchObject({ releaseReason: 'agent_offline' })
  })

  it('marks an exploration a restart cut off interrupted and writes its app map', async () => {
    const lan = await server.newUser('Lan')
    const { project, app, build } = await sampleProject(lan)
    const agent = await server.newAgent(lan, `agent-${newId()}`)
    const sample = await deviceAgent(server.url, agent.token, { udid: 'explore-5' })
    agents.push(sample)
    const [deviceRow] = await server.db.select().from(devices).where(eq(devices.agentId, agent.id))
    const repo = explorationsRepo(server.db, lan.tenantId)
    // What a server that died mid-exploration left behind: a running row, two steps, two screens.
    const row = await repo.create({
      projectId: project.id,
      appId: app.id,
      buildId: build.id,
      deviceId: deviceRow?.id ?? '',
      userId: lan.userId,
      kind: 'explore',
      budget: { max_steps: 60, max_depth: 8, max_minutes: 20, max_cost_usd: 3 },
      maxTests: 5,
      leaseTtlMs: 600_000,
    })
    if (!row) throw new Error('device busy')
    await repo.update(row.id, { status: 'running', startedAt: new Date() })
    const at = new Date().toISOString()
    const screens = [
      { fingerprint: 'aaaaaaaaaaaaaaaa', id: 'catalog', name: 'Catalog', n: 1 },
      { fingerprint: 'bbbbbbbbbbbbbbbb', id: 'menu', name: 'Menu', n: 2 },
    ]
    for (const screen of screens) {
      for (const file of ['screen.jpg', 'tree.json'] as const) {
        await server.artifacts.putBytes(
          explorationStepKey(lan.tenantId, row.id, screen.n, file),
          Buffer.from(file === 'tree.json' ? '[]' : 'jpeg'),
          file === 'tree.json' ? 'application/json' : 'image/jpeg',
        )
      }
    }
    await repo.addStep(row.id, {
      n: 1,
      segment: 1,
      fingerprint: 'aaaaaaaaaaaaaaaa',
      screenId: 'catalog',
      status: 'done',
      step: { id: 's1', action: 'tap', target: [{ desc: 'View menu' }] },
    })
    await repo.addStep(row.id, {
      n: 2,
      segment: 1,
      fingerprint: 'bbbbbbbbbbbbbbbb',
      screenId: 'menu',
      status: 'done',
      step: { id: 's2', action: 'back' },
    })
    await repo.update(row.id, {
      screens: screens.map((s) => ({
        fingerprint: s.fingerprint,
        id: s.id,
        name: s.name,
        package: SAMPLE_APP,
        first_step: s.n,
        is_new: true,
        first_seen_at: at,
      })),
    })

    expect(await server.explorations.recoverInterrupted({ tenantId: lan.tenantId })).toBe(1)
    const after = await repo.get(row.id)
    expect(after).toMatchObject({ status: 'interrupted', stopReason: 'interrupted' })
    expect(after.stats.transitions).toBe(1)
    expect(await leaseOf(row.id)).toMatchObject({ releaseReason: 'cancelled' })
    const map = parseAppMap(
      (await server.store.readFile(lan.tenantId, project.id, APPMAP_PATH, 'HEAD')) ?? null,
    )
    expect(map.screens.map((s) => s.id)).toEqual(['catalog', 'menu'])
    expect(map.transitions).toEqual([
      {
        from: 'catalog',
        to: 'menu',
        action: { action: 'tap', target: [{ desc: 'View menu' }] },
        seen_in: [row.id],
      },
    ])
    // Nothing left to recover.
    expect(await server.explorations.recoverInterrupted({ tenantId: lan.tenantId })).toBe(0)
  })
})
