// T062: artifact uploads stay inside the tenant (P5). The server builds every key itself, only for
// a run of the agent's tenant that the agent holds; a presigned URL cannot be bent to another key.
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { api } from '@coral/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { devices } from '../db/schema'
import { fakeAgent } from '../testing/fake-agent'
import { startRunServer, type RunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'

type Agent = Awaited<ReturnType<typeof fakeAgent>>

let server: RunServer
let s3: S3Client

beforeAll(async () => {
  server = await startRunServer()
  const { s3: config } = server.config
  s3 = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  })
})
afterAll(async () => {
  s3?.destroy()
  await server?.close()
})

const until = async (check: () => Promise<boolean>, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('condition not met in time')
}

/** A tenant with its own agent and a running run on its device. */
async function tenantWithRun(name: string) {
  const user: TestUser = await server.newUser(name)
  const fixture = await server.seed(user)
  const agent: Agent = await fakeAgent(server.url, fixture.agent.token)
  const [device] = await server.db
    .select()
    .from(devices)
    .where(eq(devices.agentId, fixture.agent.id))
  const created = await server.call(user, {
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
  agent.ack(job)
  await until(async () => {
    const run = api.runSchema.parse(
      (await server.call(user, { method: 'GET', url: `/runs/${runId}` })).body,
    )
    return run.status === 'running'
  })
  return { user, agent, job: job.payload, runId, itemId: job.payload.items[0]?.run_item_id ?? '' }
}

const request = (agent: Agent, runId: string, itemId: string, stepId = 's1') =>
  agent.client.send('artifact.request_upload', {
    run_id: runId,
    run_item_id: itemId,
    step_index: 0,
    step_id: stepId,
    files: [{ name: 'tree.json', content_type: 'application/json', size_bytes: 2 }],
  })

async function keysUnder(prefix: string): Promise<string[]> {
  const listed = await s3.send(
    new ListObjectsV2Command({ Bucket: server.config.s3.bucket, Prefix: prefix }),
  )
  return (listed.Contents ?? []).map((o) => o.Key ?? '')
}

describe('artifact uploads and tenants', () => {
  it('keeps every upload inside the tenant of the agent', async () => {
    const a = await tenantWithRun('Huynh')
    const b = await tenantWithRun('Mallory')

    // Tenant B's agent asks for an upload URL for tenant A's run: refused, no URL.
    const stolen = request(b.agent, a.runId, a.itemId)
    const refused = await b.agent.client.next('error', stolen.id)
    expect(refused.payload).toMatchObject({ code: 'unknown_run' })
    await expect(b.agent.client.next('artifact.upload_url', stolen.id, 300)).rejects.toThrow()

    // A step id that tries to leave the step directory is not even a valid message.
    const escape = request(b.agent, b.runId, b.itemId, '../../x')
    expect((await b.agent.client.next('error', escape.id)).payload).toMatchObject({
      code: 'invalid_message',
    })

    // Each agent uploads for its own run: keys are built by the server, under its tenant.
    const files = {
      'screenshot.png': Buffer.from('\x89PNG fake'),
      'tree.json': Buffer.from('[]'),
      'device.log': Buffer.from('log'),
    }
    const upA = await a.agent.upload(a.job, a.itemId, { index: 0, id: 's1' }, files)
    const upB = await b.agent.upload(b.job, b.itemId, { index: 0, id: 's1' }, files)
    for (const u of upA) expect(u.key.startsWith(`${a.user.tenantId}/runs/${a.runId}/`)).toBe(true)
    for (const u of upB) expect(u.key.startsWith(`${b.user.tenantId}/runs/${b.runId}/`)).toBe(true)

    // A presigned URL is bound to its key: pointing it at tenant A's prefix is rejected by S3.
    const url = new URL(upB[1]?.url ?? '')
    url.pathname = url.pathname.replace(b.user.tenantId, a.user.tenantId)
    const forged = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '["forged"]',
    })
    expect(forged.status).toBe(403)

    // Listing a tenant's prefix shows only that tenant's objects.
    const runKeysA = await keysUnder(`${a.user.tenantId}/runs/`)
    expect(runKeysA.sort()).toEqual(upA.map((u) => u.key).sort())
    const allB = await keysUnder(`${b.user.tenantId}/`)
    expect(allB.length).toBeGreaterThan(0)
    expect(allB.every((k) => k.startsWith(`${b.user.tenantId}/`))).toBe(true)
    expect(allB.some((k) => k.includes(a.runId))).toBe(false)

    a.agent.close()
    b.agent.close()
  })
})
