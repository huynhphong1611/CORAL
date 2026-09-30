import { api } from '@coral/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLog, devices } from '../db/schema'
import { fakeAgent } from '../testing/fake-agent'
import { LOGIN_YAML, startRunServer, type RunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'

let server: RunServer
let huynh: TestUser
let fixture: Awaited<ReturnType<RunServer['seed']>>
let deviceId = ''

beforeAll(async () => {
  server = await startRunServer({ secrets: { TEST_USER: 'bob@example.com' } })
  huynh = await server.newUser('Huynh')
  fixture = await server.seed(huynh)
  const agent = await fakeAgent(server.url, fixture.agent.token)
  agent.close()
  const [device] = await server.db
    .select()
    .from(devices)
    .where(eq(devices.agentId, fixture.agent.id))
  deviceId = device?.id ?? ''
})
afterAll(() => server.close())

const body = (overrides: Partial<api.CreateRun> = {}) => ({
  project_id: fixture.project.id,
  build_id: fixture.build.id,
  device_id: deviceId,
  test_case_ids: [fixture.testCase.id],
  ...overrides,
})

describe('POST /runs', () => {
  it('queues a run whose items pin the test case commit', async () => {
    const res = await server.call(huynh, { method: 'POST', url: '/runs', payload: body() })
    expect(res.status).toBe(201)
    const created = res.body as {
      id: string
      status: string
      items: { commit: string; position: number }[]
    }
    expect(created.status).toBe('queued')
    expect(created.items).toMatchObject([{ commit: fixture.testCase.head_commit, position: 0 }])

    const run = api.runSchema.parse(
      (await server.call(huynh, { method: 'GET', url: `/runs/${created.id}` })).body,
    )
    expect(run).toMatchObject({
      status: 'queued',
      device_id: deviceId,
      items: [{ slug: 'login', status: 'pending' }],
    })
    const audit = await server.db.select().from(auditLog).where(eq(auditLog.target, created.id))
    expect(audit.map((a) => a.action)).toEqual(['run.create'])
  })

  it('refuses a run whose secrets the server does not have (422 missing_secrets)', async () => {
    const yaml = LOGIN_YAML.replace('id: login', 'id: needs-otp').replace(
      'value: ${var:user}',
      "value: '${secret:OTP_SEED}'",
    )
    const tc = api.savedTestCaseSchema.parse(
      (
        await server.call(huynh, {
          method: 'POST',
          url: `/projects/${fixture.project.id}/testcases`,
          payload: { yaml },
        })
      ).body,
    )
    const res = await server.call(huynh, {
      method: 'POST',
      url: '/runs',
      payload: body({ test_case_ids: [tc.id] }),
    })
    expect(res.status).toBe(422)
    const error = api.apiErrorSchema.parse(res.body).error
    expect(error).toMatchObject({
      code: 'missing_secrets',
      details: [{ code: 'missing_secret', message: 'OTP_SEED' }],
    })
  })

  it('refuses test cases that do not target android (422 platform_mismatch)', async () => {
    const yaml = `schema: coral/testcase@1
id: ios-only
intent: 'x'
platforms: [ios]
steps:
  - id: s1
    action: launch
`
    const tc = api.savedTestCaseSchema.parse(
      (
        await server.call(huynh, {
          method: 'POST',
          url: `/projects/${fixture.project.id}/testcases`,
          payload: { yaml },
        })
      ).body,
    )
    const res = await server.call(huynh, {
      method: 'POST',
      url: '/runs',
      payload: body({ test_case_ids: [tc.id] }),
    })
    expect(res.status).toBe(422)
    expect(api.apiErrorSchema.parse(res.body).error.code).toBe('platform_mismatch')
  })

  it('refuses a build of another project (422) and non-Android devices (422)', async () => {
    const other = await server.seed(huynh)
    const res = await server.call(huynh, {
      method: 'POST',
      url: '/runs',
      payload: body({ build_id: other.build.id }),
    })
    expect(res.status).toBe(422)
    expect(api.apiErrorSchema.parse(res.body).error.code).toBe('build_not_in_project')

    await server.db.update(devices).set({ platform: 'ios' }).where(eq(devices.id, deviceId))
    const ios = await server.call(huynh, { method: 'POST', url: '/runs', payload: body() })
    await server.db.update(devices).set({ platform: 'android' }).where(eq(devices.id, deviceId))
    expect(ios.status).toBe(422)
    expect(api.apiErrorSchema.parse(ios.body).error.code).toBe('device_not_android')
  })

  it('hides resources of other tenants (404)', async () => {
    const other = await server.newUser('Other')
    expect(
      (await server.call(other, { method: 'POST', url: '/runs', payload: body() })).status,
    ).toBe(404)
  })

  it('validates the body', async () => {
    const res = await server.call(huynh, {
      method: 'POST',
      url: '/runs',
      payload: body({ test_case_ids: [] }),
    })
    expect(res.status).toBe(400)
  })
})
