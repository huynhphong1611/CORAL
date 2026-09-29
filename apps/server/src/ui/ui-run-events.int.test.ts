import { protocol, type api } from '@coral/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { devices } from '../db/schema'
import { fakeAgent } from '../testing/fake-agent'
import { startRunServer, type RunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'
import { connectUi, type UiClient } from '../testing/ui-client'
import type { ReceivedMessage } from '../testing/ws-client'
import { emulator } from '../testing/ws-client'

let server: RunServer
let huynh: TestUser
let fixture: Awaited<ReturnType<RunServer['seed']>>
let deviceId = ''
const open: UiClient[] = []

beforeAll(async () => {
  server = await startRunServer()
  huynh = await server.newUser('Huynh')
  fixture = await server.seed(huynh)
})
afterAll(async () => {
  for (const client of open) client.close()
  await server.close()
})

async function tab(user: TestUser) {
  const client = await connectUi(server.url)
  open.push(client)
  await client.auth(user.token)
  return client
}

/** Waits until a message already received (not consumed) matches. */
async function until(client: UiClient, match: (m: ReceivedMessage) => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = client.received.find(match)
    if (found) return found
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('expected message never came')
}

const ofRun = (client: UiClient, runId: string) =>
  client.received.filter(
    (m) =>
      (m.type === 'run.updated' || m.type === 'run.step') &&
      (m.payload as { run_id: string }).run_id === runId,
  )

const activityOf = (m: ReceivedMessage) =>
  protocol.uiPayloadSchemas['devices.updated']
    .parse(m.payload)
    .devices.find((d) => d.id === deviceId)?.activity.kind

async function createRun() {
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
  expect(res.status).toBe(201)
  return (res.body as { id: string }).id
}

describe('run and device events on /ws/ui (T020)', () => {
  it('sends devices.updated to every tab of the tenant when an agent brings devices', async () => {
    const watcher = await tab(huynh)
    const outsider = await tab(await server.newUser('Other'))
    const agent = await fakeAgent(server.url, fixture.agent.token, { devices: [emulator('d1')] })
    const [row] = await server.db
      .select()
      .from(devices)
      .where(eq(devices.agentId, fixture.agent.id))
    deviceId = row?.id ?? ''
    const update = await until(watcher, (m) => m.type === 'devices.updated')
    expect(activityOf(update)).toBe('idle')
    agent.close()
    await until(watcher, (m) => m.type === 'devices.updated' && activityOf(m) === 'offline')
    expect(outsider.received.filter((m) => m.type === 'devices.updated')).toEqual([])
  })

  it('streams a run to the tabs watching it, in order; another tenant cannot watch it', async () => {
    const agent = await fakeAgent(server.url, fixture.agent.token, { devices: [emulator('d1')] })
    const watcher = await tab(huynh)
    const bystander = await tab(huynh)
    const outsider = await tab(await server.newUser('Other'))
    const runId = await createRun()

    const watch = watcher.send('run.watch', { run_id: runId })
    const snapshot = await until(watcher, (m) => m.type === 'run.updated')
    expect(snapshot.re).toBeUndefined()
    const state = protocol.uiPayloadSchemas['run.updated'].parse(snapshot.payload)
    expect(state.run_id).toBe(runId)
    expect(state.items).toHaveLength(1)
    const denied = outsider.send('run.watch', { run_id: runId })
    expect((await outsider.next('error', denied.id)).payload).toMatchObject({ code: 'not_found' })

    const job = await agent.nextJob()
    // The device is leased to the run: every tab of the tenant sees it busy.
    for (const client of [watcher, bystander]) {
      await until(client, (m) => m.type === 'devices.updated' && activityOf(m) === 'run')
    }
    agent.ack(job)
    const itemId = job.payload.items[0]?.run_item_id ?? ''
    agent.step(job.payload, itemId, 0, 's1')
    agent.step(job.payload, itemId, 1, 's2', { degraded: true, duration_ms: 300 })
    agent.item(job.payload, itemId, 'passed')
    agent.done(job.payload, 'passed')
    await until(
      watcher,
      (m) => m.type === 'run.updated' && (m.payload as { status: string }).status === 'passed',
    )

    const events = ofRun(watcher, runId).map((m) =>
      m.type === 'run.step'
        ? `step ${(m.payload as { step_id: string }).step_id}`
        : `run ${(m.payload as api.Run).status} ${(m.payload as api.Run).items[0]?.status}`,
    )
    // Duplicates of one state are fine (the snapshot may repeat a change); the order is not.
    const distinct = events.filter((e, i) => e !== events[i - 1])
    expect(distinct.slice(distinct.indexOf('run running pending'))).toEqual([
      'run running pending',
      'run running running',
      'step s1',
      'step s2',
      'run running passed',
      'run passed passed',
    ])
    const s2 = ofRun(watcher, runId).find(
      (m) => m.type === 'run.step' && (m.payload as { step_id: string }).step_id === 's2',
    )
    expect(s2?.payload).toEqual({
      run_id: runId,
      run_item_id: itemId,
      step_index: 1,
      step_id: 's2',
      status: 'passed',
      degraded: true,
      duration_ms: 300,
    })
    const done = protocol.uiPayloadSchemas['run.updated'].parse(
      ofRun(watcher, runId).at(-1)?.payload,
    )
    expect(done.started_at).toBeDefined()
    expect(done.finished_at).toBeDefined()
    expect(watch.id).toBeDefined()

    // Then idle again once the run released it.
    for (const client of [watcher, bystander]) {
      const idleAfterRun = () => {
        const kinds = client.received.filter((m) => m.type === 'devices.updated').map(activityOf)
        return kinds.indexOf('run') >= 0 && kinds.lastIndexOf('idle') > kinds.indexOf('run')
      }
      await until(client, idleAfterRun)
    }
    expect(ofRun(bystander, runId)).toEqual([])
    expect(outsider.received.filter((m) => m.type !== 'error')).toEqual([])
    agent.close()
  }, 15_000)

  it('stops sending after run.unwatch', async () => {
    const agent = await fakeAgent(server.url, fixture.agent.token, { devices: [emulator('d1')] })
    const watcher = await tab(huynh)
    const runId = await createRun()
    watcher.send('run.watch', { run_id: runId })
    await until(watcher, (m) => m.type === 'run.updated')
    watcher.send('run.unwatch', { run_id: runId })
    const job = await agent.nextJob()
    agent.ack(job)
    agent.done(job.payload, 'passed')
    for (let i = 0; i < 100; i += 1) {
      const run = await server.call(huynh, { method: 'GET', url: `/runs/${runId}` })
      if ((run.body as api.Run).finished_at) break
      await new Promise((r) => setTimeout(r, 20))
    }
    await new Promise((r) => setTimeout(r, 100))
    expect(ofRun(watcher, runId)).toHaveLength(1)
    agent.close()
  })
})
