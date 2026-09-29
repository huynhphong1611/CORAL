// T061: the server hands secret values to agents in job.assign but never writes them to its log
// (SPEC §8.6, D19, SC-008), even at trace level and on the error paths of the run pipeline.
import { MASK, api } from '@coral/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { devices } from '../db/schema'
import { fakeAgent } from '../testing/fake-agent'
import { startRunServer, type RunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'

const SECRET = 'swordfish-2026-secret'
const lines: string[] = []

let server: RunServer
let huynh: TestUser

beforeAll(async () => {
  server = await startRunServer({
    secrets: { TEST_USER: SECRET },
    logging: { level: 'trace', stream: { write: (line) => void lines.push(line) } },
  })
  huynh = await server.newUser('Huynh')
})
afterAll(() => server.close())

const until = async (check: () => Promise<boolean>, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('condition not met in time')
}

describe('server log and secrets', () => {
  it('never logs a secret value, not even the job.assign that carries it', async () => {
    const fixture = await server.seed(huynh)
    const agent = await fakeAgent(server.url, fixture.agent.token)
    const [device] = await server.db
      .select()
      .from(devices)
      .where(eq(devices.agentId, fixture.agent.id))
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
    const runId = (created.body as { id: string }).id
    const job = await agent.nextJob()
    // The value really went through the server.
    expect(job.payload.secrets).toEqual({ TEST_USER: SECRET })
    agent.ack(job)
    const itemId = job.payload.items[0]?.run_item_id ?? ''

    // Error paths that log: a malformed message and a result for a run the agent does not hold.
    agent.client.ws.send('{"type":"step.result","payload":{"oops":true}}')
    agent.step({ ...job.payload, run_id: '0192f000-0000-7000-8000-00000000dead' }, itemId, 0, 's1')
    agent.step(job.payload, itemId, 0, 's1', {
      status: 'failed',
      failure_code: 'EXPECT_FAILED',
      message: `text "Goodbye ${MASK}" is not visible`,
    })
    agent.item(job.payload, itemId, 'failed', {
      failure_code: 'EXPECT_FAILED',
      failed_step_id: 's1',
    })
    agent.done(job.payload, 'failed')
    const getRun = async () =>
      api.runSchema.parse((await server.call(huynh, { method: 'GET', url: `/runs/${runId}` })).body)
    await until(async () => (await getRun()).status === 'failed')
    agent.close()

    const log = lines.join('')
    expect(log).toContain('incoming request')
    expect(log).toContain('message for a run this agent does not hold')
    expect(log.split(SECRET).length - 1).toBe(0)
  })
})
