import { createHash } from 'node:crypto'
import { api } from '@coral/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { devices } from '../db/schema'
import { assetKey } from '../storage/keys'
import { fakeAgent } from '../testing/fake-agent'
import { startRunServer, type RunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'

// US6 T052: the reference images of `image` locators go with the job — read from the project repo
// at the item's commit, stored by content (<tenant>/assets/<sha256>), presigned for the agent.
let server: RunServer
let huynh: TestUser
let fixture: Awaited<ReturnType<RunServer['seed']>>
let agent: Awaited<ReturnType<typeof fakeAgent>>
let deviceId = ''
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const sha256 = createHash('sha256').update(PNG).digest('hex')

const MENU = `schema: coral/testcase@1
id: menu
intent: Open the menu
platforms: [android]
steps:
  - id: s1
    action: launch
  - id: s2
    action: tap
    target:
      - android_id: id/menuIV
      - image: { path: snap/menu/s2/element.png, screen_width: 1080 }
    expect: { visible_text: Log In }
`

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
})
afterAll(async () => {
  agent.client.ws.close()
  await server.close()
})

describe('image assets in job.assign (T052)', () => {
  it('sends each referenced image by content with a presigned URL', async () => {
    await server.store.commitFiles(huynh.tenantId, fixture.project.id, {
      files: { 'snap/menu/s2/element.png': PNG },
      author: { name: 'Huynh', email: 'huynh@example.com' },
      message: 'snapshots',
    })
    const created = await server.call(huynh, {
      method: 'POST',
      url: `/projects/${fixture.project.id}/testcases`,
      payload: { yaml: MENU },
    })
    expect(created.status).toBe(201)
    const menu = api.savedTestCaseSchema.parse(created.body)

    const run = await server.call(huynh, {
      method: 'POST',
      url: '/runs',
      payload: {
        project_id: fixture.project.id,
        build_id: fixture.build.id,
        device_id: deviceId,
        test_case_ids: [fixture.testCase.id, menu.id],
      },
    })
    expect(run.status).toBe(201)
    const job = await agent.nextJob()
    agent.ack(job)
    const [login, withImage] = job.payload.items
    // A test case without image locators gets none.
    expect(login?.assets).toEqual([])
    expect(withImage?.assets).toEqual([
      { path: 'snap/menu/s2/element.png', sha256, download_url: expect.any(String) as string },
    ])
    const download = await fetch(withImage?.assets[0]?.download_url ?? '')
    expect(Buffer.from(await download.arrayBuffer())).toEqual(PNG)
    expect(await server.artifacts.size(assetKey(huynh.tenantId, sha256))).toBe(PNG.length)
    expect(withImage?.assets[0]?.download_url).toContain(`${huynh.tenantId}/assets/${sha256}`)
  })
})
