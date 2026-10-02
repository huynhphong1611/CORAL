import { api } from '@coral/shared'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { devices, runItems, runSteps, runs } from '../db/schema'
import { fakeAgent } from '../testing/fake-agent'
import { startRunServer, type RunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'

// T019: `expect.screen` — the agent gets the app map fingerprints of the screens a test case names,
// read at the item's commit; an item naming an unknown screen is not sent and ends in error.
let server: RunServer
let huynh: TestUser
let fixture: Awaited<ReturnType<RunServer['seed']>>
let agent: Awaited<ReturnType<typeof fakeAgent>>
let deviceId = ''
const FINGERPRINT = '9f2c4e71a0b3d5e8'

const withScreen = (id: string, screen: string) => `schema: coral/testcase@1
id: ${id}
intent: Shows the ${screen}
platforms: [android]
steps:
  - id: s1
    action: launch
  - id: s2
    action: assert
    expect: [{ visible_text: Products }, { screen: ${screen} }]
`

const appMap = JSON.stringify({
  schema: 'coral/appmap@1',
  screens: [
    {
      id: 'catalog',
      name: 'Danh sách sản phẩm',
      fingerprint: FINGERPRINT,
      package: 'com.saucelabs.mydemoapp.android',
      snapshot: 'appmap/snap/catalog',
      first_seen_at: '2026-10-01T08:00:00Z',
    },
  ],
  transitions: [],
})

async function save(yaml: string) {
  const created = await server.call(huynh, {
    method: 'POST',
    url: `/projects/${fixture.project.id}/testcases`,
    payload: { yaml },
  })
  expect(created.status).toBe(201)
  return api.savedTestCaseSchema.parse(created.body)
}

async function startRun(testCaseIds: string[]) {
  const run = await server.call(huynh, {
    method: 'POST',
    url: '/runs',
    payload: {
      project_id: fixture.project.id,
      build_id: fixture.build.id,
      device_id: deviceId,
      test_case_ids: testCaseIds,
    },
  })
  expect(run.status).toBe(201)
  return (run.body as { id: string }).id
}

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
  await server.store.commitFiles(huynh.tenantId, fixture.project.id, {
    files: { 'appmap/screens.json': appMap },
    author: { name: 'Huynh', email: 'huynh@example.com' },
    message: 'appmap',
  })
})
afterAll(async () => {
  agent.client.ws.close()
  await server.close()
})

describe('expect.screen in job.assign (T019, D24)', () => {
  it('sends the fingerprints of the named screens and keeps unknown screens out of the job', async () => {
    const catalog = await save(withScreen('shows-catalog', 'catalog'))
    const cart = await save(withScreen('shows-cart', 'gio-hang'))
    const runId = await startRun([fixture.testCase.id, catalog.id, cart.id])

    const job = await agent.nextJob()
    agent.ack(job)
    expect(job.payload.items.map((i) => [i.test_case_id, i.screens])).toEqual([
      [fixture.testCase.id, {}],
      [catalog.id, { catalog: FINGERPRINT }],
    ])

    const [item] = await server.db
      .select()
      .from(runItems)
      .where(and(eq(runItems.runId, runId), eq(runItems.testCaseId, cart.id)))
    expect(item).toMatchObject({ status: 'error', failedStepId: 's2' })
    const [step] = await server.db
      .select()
      .from(runSteps)
      .where(eq(runSteps.runItemId, item?.id ?? ''))
    expect(step).toMatchObject({ stepId: 's2', stepIndex: 1, status: 'failed' })
    expect(step?.message).toMatch(
      /^unknown_screen: screen "gio-hang" is not in appmap\/screens\.json/,
    )

    // The agent runs what it got; the run fails because of the item that never went.
    for (const sent of job.payload.items) agent.item(job.payload, sent.run_item_id, 'passed')
    agent.done(job.payload, 'passed')
    await expect
      .poll(async () => (await server.db.select().from(runs).where(eq(runs.id, runId)))[0]?.status)
      .toBe('failed')
  })

  it('ends the run in error without a job when no item is left', async () => {
    const cart = await save(withScreen('only-cart', 'gio-hang'))
    const runId = await startRun([cart.id])
    await expect
      .poll(async () => {
        const [run] = await server.db.select().from(runs).where(eq(runs.id, runId))
        return run?.status
      })
      .toBe('error')
    const [item] = await server.db.select().from(runItems).where(eq(runItems.runId, runId))
    expect(item?.status).toBe('error')
  })
})
