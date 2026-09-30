import { api } from '@coral/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { devices } from '../db/schema'
import { fakeAgent } from '../testing/fake-agent'
import { LOGIN_YAML, startRunServer, type RunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'
import { emulator } from '../testing/ws-client'

let server: RunServer
let huynh: TestUser
let fixture: Awaited<ReturnType<RunServer['seed']>>
let deviceA = ''
let deviceB = ''
let caseA = ''
let caseB = ''
const run: Record<string, string> = {}

beforeAll(async () => {
  server = await startRunServer()
  huynh = await server.newUser('Huynh')
  fixture = await server.seed(huynh)
  const agent = await fakeAgent(server.url, fixture.agent.token, {
    devices: [emulator('a'), emulator('b')],
  })
  agent.close()
  const rows = await server.db.select().from(devices).where(eq(devices.agentId, fixture.agent.id))
  deviceA = rows.find((d) => d.udid === 'a')?.id ?? ''
  deviceB = rows.find((d) => d.udid === 'b')?.id ?? ''
  caseA = fixture.testCase.id
  caseB = api.savedTestCaseSchema.parse(
    (
      await server.call(huynh, {
        method: 'POST',
        url: `/projects/${fixture.project.id}/testcases`,
        payload: { yaml: LOGIN_YAML.replace('id: login', 'id: login-again') },
      })
    ).body,
  ).id
  // Created in this order, so listed newest first: both, b2, a1.
  for (const [name, device, cases] of [
    ['a1', deviceA, [caseA]],
    ['b2', deviceB, [caseB]],
    ['both', deviceA, [caseA, caseB]],
  ] as const) {
    const res = await server.call(huynh, {
      method: 'POST',
      url: '/runs',
      payload: {
        project_id: fixture.project.id,
        build_id: fixture.build.id,
        device_id: device,
        test_case_ids: cases,
      },
    })
    run[name] = (res.body as { id: string }).id
  }
})
afterAll(() => server.close())

async function list(query: string, user = huynh) {
  const res = await server.call(user, { method: 'GET', url: `/runs?${query}` })
  expect(res.status).toBe(200)
  const page = res.body as { items: api.Run[]; next_cursor: string | null }
  return { ids: page.items.map((r) => r.id), next: page.next_cursor }
}

describe('GET /runs filters (FR-003)', () => {
  it('filters by device', async () => {
    expect((await list(`device_id=${deviceA}`)).ids).toEqual([run.both, run.a1])
    expect((await list(`device_id=${deviceB}`)).ids).toEqual([run.b2])
  })

  it('filters by test case: runs with an item of it', async () => {
    expect((await list(`test_case_id=${caseA}`)).ids).toEqual([run.both, run.a1])
    expect((await list(`test_case_id=${caseB}`)).ids).toEqual([run.both, run.b2])
  })

  it('combines filters and pages through them', async () => {
    expect((await list(`device_id=${deviceA}&test_case_id=${caseB}`)).ids).toEqual([run.both])
    const first = await list(`test_case_id=${caseA}&limit=1`)
    expect(first.ids).toEqual([run.both])
    const second = await list(`test_case_id=${caseA}&limit=1&cursor=${first.next}`)
    expect(second).toEqual({ ids: [run.a1], next: null })
  })

  it('refuses a malformed id and shows another tenant nothing', async () => {
    const bad = await server.call(huynh, { method: 'GET', url: '/runs?device_id=nope' })
    expect(bad.status).toBe(400)
    const other = await server.newUser('Other')
    expect((await list(`device_id=${deviceA}`, other)).ids).toEqual([])
    expect((await list(`test_case_id=${caseA}`, other)).ids).toEqual([])
  })
})
