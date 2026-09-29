// End-to-end (T054, SC-002): a real coral-server pipeline (Postgres, Redis, MinIO, git store,
// gateway, dispatcher, ingest) and the real coral-agent code, with FakeDriver instead of a phone.
// Lives in scripts/ because apps never import each other (D08).
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { api } from '@coral/shared'
import { FakeClock, FakeDriver, el, windows } from '@coral/runner/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startAgent, type Agent } from '../apps/agent/src/agent'
import type { RunnableDriver } from '../apps/agent/src/jobs'
import { startRunServer, type RunServer } from '../apps/server/src/testing/run-server'
import type { TestUser } from '../apps/server/src/testing/test-server'

const APP = 'com.example.app'
const login = windows(
  APP,
  el({
    bounds: [0, 0, 1080, 2400],
    children: [
      el({
        platform_id: `${APP}:id/user`,
        class: 'android.widget.EditText',
        clickable: true,
        bounds: [100, 100, 800, 120],
      }),
      el({
        text: 'Login',
        class: 'android.widget.Button',
        clickable: true,
        bounds: [100, 300, 800, 120],
      }),
    ],
  }),
)
const home = windows(
  APP,
  el({
    bounds: [0, 0, 1080, 2400],
    children: [el({ text: 'Products', bounds: [0, 100, 1080, 100] })],
  }),
)

let server: RunServer
let agent: Agent
let huynh: TestUser
let cacheDir = ''
const drivers: FakeDriver[] = []

beforeAll(async () => {
  server = await startRunServer({ secrets: { TEST_USER: 'bob@example.com' } })
  huynh = await server.newUser('Huynh')
  cacheDir = await mkdtemp(join(tmpdir(), 'coral-e2e-'))
})
afterAll(async () => {
  await agent?.stop()
  await server?.close()
  await rm(cacheDir, { recursive: true, force: true })
})

const until = async <T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('Phase 1 end to end', () => {
  it('runs a test case through server and agent, with every artifact downloadable', async () => {
    const fixture = await server.seed(huynh)
    agent = startAgent({
      wsUrl: `${server.url.replace(/^http/, 'ws')}/ws/agent`,
      token: fixture.agent.token,
      cacheDir,
      clock: new FakeClock(),
      minBackoffMs: 50,
      source: {
        list: () => Promise.resolve([{ udid: 'emulator-5554', state: 'device' }]),
        props: () =>
          Promise.resolve({ model: 'sdk_gphone64', osVersion: '14', apiLevel: 34, emulator: true }),
      },
      createDriver: () => {
        const driver = new FakeDriver({
          screens: {
            login: { frames: [login], taps: { Login: 'home' } },
            home: { frames: [home] },
          },
          start: 'login',
        })
        drivers.push(driver)
        return Promise.resolve(
          Object.assign(driver, {
            open: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }) as unknown as RunnableDriver,
        )
      },
    })

    const device = await until(
      async () =>
        api.deviceSchema
          .array()
          .parse((await server.call(huynh, { method: 'GET', url: '/devices' })).body)
          .find((d) => d.agent_id === fixture.agent.id),
      (d) => d?.status === 'idle',
    )
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
    expect(created.status).toBe(201)
    const runId = (created.body as { id: string }).id

    const run = await until(
      async () =>
        api.runSchema.parse(
          (await server.call(huynh, { method: 'GET', url: `/runs/${runId}` })).body,
        ),
      (r) => !['queued', 'running'].includes(r.status),
    )
    const finishedAt = Date.now()
    expect(run).toMatchObject({ status: 'passed', items: [{ status: 'passed', slug: 'login' }] })

    const steps = api.runStepSchema.array().parse(
      (
        await server.call(huynh, {
          method: 'GET',
          url: `/runs/${runId}/items/${run.items[0]?.id}/steps`,
        })
      ).body,
    )
    expect(steps.map((s) => [s.step_id, s.status])).toEqual([
      ['s1', 'passed'],
      ['s2', 'passed'],
      ['s3', 'passed'],
    ])
    for (const step of steps) {
      const shot = await fetch(step.artifacts.screenshot_url ?? '')
      const tree = await fetch(step.artifacts.tree_url ?? '')
      expect([shot.status, tree.status]).toEqual([200, 200])
      expect(api.runStepSchema.shape.artifacts.parse(step.artifacts).log_url).toBeNull()
      expect(JSON.parse(await tree.text())).toBeInstanceOf(Array)
    }
    // SC-002: evidence is there within 10 s of job.done.
    expect(Date.now() - finishedAt).toBeLessThan(10_000)

    // The build went through S3 to the agent's cache and was installed once.
    expect(drivers[0]?.calls.filter((c) => c.kind === 'install')).toEqual([
      {
        kind: 'install',
        path: join(cacheDir, 'builds', `${fixture.build.checksum_sha256}.apk`),
        sha256: fixture.build.checksum_sha256,
      },
    ])
    expect(drivers[0]?.calls.find((c) => c.kind === 'type')).toEqual({
      kind: 'type',
      text: 'bob@example.com',
    })
  }, 60_000)
})
