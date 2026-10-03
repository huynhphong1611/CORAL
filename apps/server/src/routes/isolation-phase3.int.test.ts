import { readFileSync } from 'node:fs'
import { api } from '@coral/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { explorationsRepo } from '../repos/explorations'
import type { DeviceAgent } from '../testing/device-agent'
import { multipart } from '../testing/multipart'
import { startRunServer, type RunServer } from '../testing/run-server'
import { sampleDevice, sampleProject } from '../testing/sample-project'
import type { TestUser } from '../testing/test-server'
import { connectUi, type UiClient } from '../testing/ui-client'

// T062 (SC-008, P5): every route and /ws/ui message Phase 3 added, called by another tenant's
// owner with the ids of Huynh's project — exploration, trace, brain call, app map and its files,
// knowledge (AGENTS.md, skills, mcp.yaml), import job, AI test case, brains config and AI usage.
// Each answers 404 (or an empty list, or the caller's own data); the watches answer not_found.

const BRAINS = `schema: coral/brains@1
roles:
  explorer: { provider: fake, model: fake }
limits:
  max_cost_usd_per_day: 7
  max_cost_usd_per_exploration: 3
`

let server: RunServer
let huynh: TestUser
let lan: TestUser
let fixture: Awaited<ReturnType<typeof sampleProject>>
let deviceId = ''
const agents: DeviceAgent[] = []
const tabs: UiClient[] = []

/** What Huynh made, by id, for Lan to ask for. */
const mine = {
  exploration: '',
  brainCall: '',
  testCase: '',
  snapshot: '',
  importJob: '',
}

beforeAll(async () => {
  server = await startRunServer({ explorer: { validate: false } })
  huynh = await server.newUser('Huynh')
  lan = await server.newUser('Lan')
  fixture = await sampleProject(server, huynh)
  const found = await sampleDevice(server, huynh, 'isolation-1')
  agents.push(found.sample)
  deviceId = found.deviceId
  const projectId = fixture.project.id

  // Huynh's own brains config, a skill, mcp.yaml.
  expect(
    (
      await server.call(huynh, {
        method: 'PUT',
        url: '/brains/config',
        payload: BRAINS,
        headers: { 'content-type': 'application/yaml' },
      })
    ).status,
  ).toBe(200)
  const head = api.agentsMdSchema.parse(
    (await server.call(huynh, { method: 'GET', url: `/projects/${projectId}/agents-md` })).body,
  ).head_commit
  expect(
    (
      await server.call(huynh, {
        method: 'PUT',
        url: `/projects/${projectId}/skills/checkout`,
        payload: {
          skill_md: '---\nname: checkout\ndescription: HUYNH-ONLY skill\n---\nBody\n',
          base_commit: head,
        },
      })
    ).status,
  ).toBe(200)
  const mcp = api.mcpFileSchema.parse(
    (await server.call(huynh, { method: 'GET', url: `/projects/${projectId}/mcp` })).body,
  )
  expect(
    (
      await server.call(huynh, {
        method: 'PUT',
        url: `/projects/${projectId}/mcp`,
        payload: {
          yaml: 'schema: coral/mcp@1\nservers:\n  otp:\n    url: http://127.0.0.1:9/mcp\n    tools:\n      get_otp: {}\n',
          base_commit: mcp.head_commit,
        },
      })
    ).status,
  ).toBe(200)

  // An exploration with a goal: a trace, brain calls, an app map, one AI test case.
  const started = await server.explorations.start(
    { tenantId: huynh.tenantId, userId: huynh.userId },
    {
      project_id: projectId,
      app_id: fixture.app.id,
      build_id: fixture.build.id,
      device_id: deviceId,
      goal: 'Open the cart until "My Cart"',
    },
  )
  mine.exploration = started.id
  const repo = explorationsRepo(server.db, huynh.tenantId)
  const deadline = Date.now() + 60_000
  for (;;) {
    const row = await repo.get(started.id)
    if (['done', 'stopped', 'failed', 'interrupted'].includes(row.status)) break
    if (Date.now() > deadline) throw new Error(`exploration still ${row.status}`)
    await new Promise((r) => setTimeout(r, 100))
  }
  const detail = (await server.call(huynh, { method: 'GET', url: `/explorations/${started.id}` }))
    .body as { test_cases: { id: string }[] }
  mine.testCase = detail.test_cases[0]?.id ?? ''
  const steps = await repo.steps(started.id, { limit: 100 })
  mine.brainCall = steps.find((s) => s.brainCallId)?.brainCallId ?? ''
  const map = api.projectAppMapSchema.parse(
    (await server.call(huynh, { method: 'GET', url: `/projects/${projectId}/appmap` })).body,
  )
  mine.snapshot = map.screens[0]?.snapshot ?? ''

  // An import job, in preview.
  const upload = await server.call(huynh, {
    method: 'POST',
    url: `/projects/${projectId}/imports`,
    ...multipart(
      {},
      {
        name: 'login-en.csv',
        data: readFileSync(new URL('../../../../fixtures/manual/login-en.csv', import.meta.url)),
      },
    ),
  })
  mine.importJob = api.importPreviewSchema.parse(upload.body).import_job_id
}, 120_000)
afterAll(async () => {
  for (const tab of tabs) tab.close()
  for (const agent of agents) agent.close()
  await server.close()
})

describe('tenant isolation of Phase 3 (T062, SC-008)', () => {
  it('found what it needs on Huynh’s side', () => {
    for (const [what, id] of Object.entries(mine)) expect(id, what).not.toBe('')
  })

  it('answers 404 to every route Lan calls with Huynh’s ids', async () => {
    const p = fixture.project.id
    const routes: [string, string, object?][] = [
      // Explorations and their trace.
      ['GET', `/explorations/${mine.exploration}`],
      ['GET', `/explorations/${mine.exploration}/steps`],
      ['POST', `/explorations/${mine.exploration}/stop`],
      [
        'POST',
        '/explorations',
        {
          project_id: p,
          app_id: fixture.app.id,
          build_id: fixture.build.id,
          device_id: deviceId,
        },
      ],
      // What the AI was sent and answered.
      ['GET', `/brain-calls/${mine.brainCall}`],
      // The app map and its files.
      ['GET', `/projects/${p}/appmap`],
      ['GET', `/projects/${p}/files/${mine.snapshot}/screen.jpg`],
      ['GET', `/projects/${p}/files/${mine.snapshot}/tree.json`],
      // Knowledge.
      ['GET', `/projects/${p}/agents-md`],
      ['PUT', `/projects/${p}/agents-md`, { content: 'x', base_commit: '0'.repeat(40) }],
      ['GET', `/projects/${p}/skills`],
      ['GET', `/projects/${p}/skills/checkout`],
      [
        'PUT',
        `/projects/${p}/skills/checkout`,
        { skill_md: '---\nname: checkout\ndescription: x\n---\n', base_commit: '0'.repeat(40) },
      ],
      ['DELETE', `/projects/${p}/skills/checkout?base_commit=${'0'.repeat(40)}`],
      ['GET', `/projects/${p}/mcp`],
      [
        'PUT',
        `/projects/${p}/mcp`,
        { yaml: 'schema: coral/mcp@1\nservers: {}\n', base_commit: '0'.repeat(40) },
      ],
      // Imports.
      ['GET', `/imports/${mine.importJob}`],
      [
        'PATCH',
        `/imports/${mine.importJob}`,
        { mapping: { title: 1, steps: [3], expected: [4], header_row: 0 } },
      ],
      [
        'POST',
        `/imports/${mine.importJob}/start`,
        { app_id: fixture.app.id, build_id: fixture.build.id, device_id: deviceId },
      ],
      ['POST', `/imports/${mine.importJob}/cancel`],
      ['DELETE', `/imports/${mine.importJob}`],
      // The AI test case.
      ['PATCH', `/testcases/${mine.testCase}`, { status: 'active' }],
    ]
    for (const [method, url, payload] of routes) {
      const res = await server.call(lan, {
        method: method as 'GET',
        url,
        ...(payload ? { payload } : {}),
      })
      expect(res.status, `${method} ${url}`).toBe(404)
    }
    // An upload into Huynh's project.
    const upload = await server.call(lan, {
      method: 'POST',
      url: `/projects/${p}/imports`,
      ...multipart({}, { name: 'a.csv', data: Buffer.from('Title,Steps\nA,B\n') }),
    })
    expect(upload.status).toBe(404)
    // Huynh's things are all still there.
    for (const url of [
      `/explorations/${mine.exploration}`,
      `/imports/${mine.importJob}`,
      `/projects/${p}/skills/checkout`,
    ]) {
      expect((await server.call(huynh, { method: 'GET', url })).status, url).toBe(200)
    }
  })

  it('lists nothing of Huynh’s and keeps the brains config and AI usage per tenant', async () => {
    const p = fixture.project.id
    for (const url of [`/explorations?project_id=${p}`, `/imports?project_id=${p}`]) {
      const res = await server.call(lan, { method: 'GET', url })
      // Another tenant's project: not found, or simply nothing of it.
      if (res.status !== 404) expect(res.body, url).toEqual([])
    }
    expect((await server.call(lan, { method: 'GET', url: '/explorations' })).body).toEqual([])

    const config = (await server.call(lan, { method: 'GET', url: '/brains/config' })).body as {
      source: string
      yaml: string
    }
    expect(config.source).not.toBe('tenant')
    expect(config.yaml).not.toContain('max_cost_usd_per_day: 7')

    const usage = (await server.call(lan, { method: 'GET', url: '/usage/ai?group=provider' }))
      .body as { rows: unknown[]; total_cost_usd: number; today: { cost_usd: number } }
    expect(usage).toMatchObject({ rows: [], total_cost_usd: 0, today: { cost_usd: 0 } })
    // Huynh's own usage counts his calls.
    const his = (await server.call(huynh, { method: 'GET', url: '/usage/ai?group=provider' }))
      .body as { rows: { calls: number }[] }
    expect(his.rows.reduce((n, r) => n + r.calls, 0)).toBeGreaterThan(0)
  })

  it('answers not_found to Lan’s watches of Huynh’s exploration and import', async () => {
    const tab = await connectUi(server.url)
    tabs.push(tab)
    await tab.auth(lan.token)
    const exploration = tab.send('exploration.watch', { exploration_id: mine.exploration })
    expect((await tab.next('error', exploration.id)).payload).toMatchObject({ code: 'not_found' })
    const job = tab.send('import.watch', { import_job_id: mine.importJob })
    expect((await tab.next('error', job.id)).payload).toMatchObject({ code: 'not_found' })
  })
})
