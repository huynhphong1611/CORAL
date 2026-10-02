import { readFileSync } from 'node:fs'
import { api } from '@coral/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { explorations as explorationsTable } from '../db/schema'
import { importsRepo } from '../repos/imports'
import { projectsRepo } from '../repos/projects'
import { testCasesRepo } from '../repos/test-cases'
import type { DeviceAgent } from '../testing/device-agent'
import { multipart } from '../testing/multipart'
import { startRunServer, type RunServer } from '../testing/run-server'
import { sampleDevice, sampleProject } from '../testing/sample-project'
import type { TestUser } from '../testing/test-server'
import { ImportService } from './service'

// US6 (T054): an import job works through its cases one by one on the fake sample app with the
// `fake` brain — a case it can follow becomes an active `ai_import` test case, the others stay
// draft with why (needs_human, ambiguous, app_mismatch, duplicate) and the step that shows it;
// a restart goes on from the first pending case without redoing one done; a cancel or an empty
// budget leaves the rest not_processed.

const CASES = `Title,Steps,Expected
Open the cart,Tap the cart icon,"""My Cart"" shows"
Log in with a code sent by SMS,Type the OTP code from the SMS,The catalog shows
Do something,Tap something...,Something happens
The cart shows a wrong total,Tap the cart icon,"""Total: $ 0.00"" shows"
`

let server: RunServer
let huynh: TestUser
let project: Awaited<ReturnType<typeof sampleProject>>
let deviceId = ''
const agents: DeviceAgent[] = []

/** Answers the validation runs of written test cases: every item passes. */
async function answerJobs(agent: DeviceAgent['agent']) {
  for (;;) {
    let job
    try {
      job = await agent.nextJob(600_000)
    } catch {
      return
    }
    agent.ack(job)
    for (const item of job.payload.items) agent.item(job.payload, item.run_item_id, 'passed')
    agent.done(job.payload, 'passed')
  }
}

beforeAll(async () => {
  server = await startRunServer({ explorer: {} })
  huynh = await server.newUser('Huynh')
  project = await sampleProject(server, huynh)
  const found = await sampleDevice(server, huynh, 'imports-job')
  agents.push(found.sample)
  deviceId = found.deviceId
  void answerJobs(found.sample.agent)
})
afterAll(async () => {
  for (const agent of agents) agent.close()
  await server.close()
})

async function importCsv(csv: string, budget?: Partial<api.ImportBudget>) {
  const preview = api.importPreviewSchema.parse(
    (
      await server.call(huynh, {
        method: 'POST',
        url: `/projects/${project.project.id}/imports`,
        ...multipart({}, { name: 'cases.csv', data: Buffer.from(csv) }),
      })
    ).body,
  )
  const started = await server.call(huynh, {
    method: 'POST',
    url: `/imports/${preview.import_job_id}/start`,
    payload: {
      app_id: project.app.id,
      build_id: project.build.id,
      device_id: deviceId,
      ...(budget ? { budget } : {}),
    },
  })
  if (started.status !== 202) throw new Error(`not started: ${JSON.stringify(started.body)}`)
  return preview.import_job_id
}

const detail = async (id: string) =>
  api.importJobDetailSchema.parse(
    (await server.call(huynh, { method: 'GET', url: `/imports/${id}` })).body,
  )

async function until(id: string, done: (job: api.ImportJobDetail) => boolean, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = await detail(id)
    if (done(job)) return job
    if (Date.now() > deadline) throw new Error(`import still ${job.status}: ${JSON.stringify(job)}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}
const ended = (job: api.ImportJobDetail) => job.status !== 'running'

describe('import job (US6, T054)', { timeout: 180_000 }, () => {
  it('turns each case into an active test case, or a draft with why', async () => {
    const id = await importCsv(CASES)
    const job = await until(id, ended)
    expect(job.status).toBe('done')
    expect(job.items.map((i) => [i.title, i.status, i.reason])).toEqual([
      ['Open the cart', 'active', null],
      ['Log in with a code sent by SMS', 'draft', 'needs_human'],
      ['Do something', 'draft', 'ambiguous'],
      ['The cart shows a wrong total', 'draft', 'app_mismatch'],
    ])
    expect(job.report).toMatchObject({
      total: 4,
      active: 1,
      draft: { needs_human: 1, ambiguous: 1, app_mismatch: 1, validation_failed: 0, duplicate: 0 },
      not_processed: 0,
    })
    expect(job.stats).toMatchObject({ total: 4, done: 4, active: 1, draft: 3 })
    expect(job.stats.cost_usd).toBeGreaterThan(0)

    // Why, with the step that shows it (and its picture).
    const [cart, sms, , wrong] = job.items
    expect(sms?.evidence).toMatchObject({
      step_n: 1,
      message: expect.stringContaining('code') as string,
    })
    expect(sms?.evidence?.screenshot_url).toMatch(/^http/)
    expect(wrong?.evidence?.message).toBe('The app never showed "Total: $ 0.00"')

    // The test case says where it came from; the expected result is kept as written.
    const testCases = testCasesRepo(
      server.db,
      huynh.tenantId,
      server.store,
      projectsRepo(server.db, huynh.tenantId, server.store),
    )
    const testCase = await testCases.get(cart?.test_case_id ?? '')
    expect(testCase).toMatchObject({ source: 'ai_import', status: 'active' })
    expect(testCase.sourceRef).toMatch(/^import_item:/)
    expect(await testCases.readYaml(testCase)).toContain('visible_text: My Cart')
    const items = await importsRepo(server.db, huynh.tenantId).items(id)
    const manual = await server.store.readFile(
      huynh.tenantId,
      project.project.id,
      items[3]?.manualPath ?? '',
    )
    expect(manual).toContain('Total: $ 0.00')

    // Each case was one exploration of kind import.
    const rows = await server.db
      .select()
      .from(explorationsTable)
      .where(eq(explorationsTable.tenantId, huynh.tenantId))
    const mine = rows.filter((r) => items.some((i) => i.id === r.importItemId))
    expect(mine.map((r) => r.kind)).toEqual(['import', 'import', 'import', 'import'])
    expect(mine.every((r) => r.maxTests === 1 && r.budget.max_steps <= 25)).toBe(true)
  })

  it('goes on after a restart from the first pending case, not redoing a done one', async () => {
    // A project of its own: the cart test case of the first test would make it a duplicate.
    project = await sampleProject(server, huynh)
    const id = await importCsv(`Title,Steps,Expected
Open the cart again,Tap the cart icon,"""My Cart"" shows"
Open the cart once more,Tap the cart icon,"""My Cart"" shows"
`)
    const repo = importsRepo(server.db, huynh.tenantId)
    // The first case is on its way: the server "stops" (its runs end after the case they are on).
    await until(id, (job) => job.items[0]?.exploration_id !== null)
    server.imports.close()
    await until(id, (job) => job.items[0]?.status !== 'running')
    const first = (await detail(id)).items[0]
    expect(first?.status).toBe('active')
    // As if it died on the second case.
    await repo.updateItem(id, 2, { status: 'running' })

    const restarted = new ImportService({
      db: server.db,
      store: server.store,
      artifacts: server.artifacts,
      agents: server.gateway,
      ai: {
        ready: () => Promise.reject(new Error('not used')),
        secretValues: () => ({}),
      },
      explorations: server.explorations,
      pollMs: 100,
      retryMs: 300,
    })
    expect(await restarted.resume()).toBeGreaterThanOrEqual(1)
    const job = await until(id, ended)
    expect(job.status).toBe('done')
    expect(job.items[0]).toEqual(first)
    // Same steps as the first: the second is a duplicate of it.
    expect(job.items[1]).toMatchObject({ status: 'draft', reason: 'duplicate' })
    expect(job.items[1]?.evidence?.message).toContain('the same steps as test case')
    restarted.close()
  })
})

describe('import job ends early (US6, T054)', { timeout: 180_000 }, () => {
  // The first server's imports were "stopped" by the restart test.
  beforeAll(async () => {
    await server.close()
    server = await startRunServer({ explorer: {} })
    huynh = await server.newUser('Lan')
    project = await sampleProject(server, huynh)
    const found = await sampleDevice(server, huynh, 'imports-cancel')
    agents.push(found.sample)
    deviceId = found.deviceId
    void answerJobs(found.sample.agent)
  })

  it('leaves the cases not done not_processed on cancel', async () => {
    const id = await importCsv(`Title,Steps,Expected
The cart shows a wrong total,Tap the cart icon,"""Total: $ 0.00"" shows"
Open the cart,Tap the cart icon,"""My Cart"" shows"
Open the menu,Tap the menu icon,"""Log In"" shows"
`)
    await until(id, (job) => job.items[0]?.exploration_id !== null)
    const cancel = await server.call(huynh, { method: 'POST', url: `/imports/${id}/cancel` })
    expect(cancel.status).toBe(202)
    const job = await until(id, ended)
    expect(job.status).toBe('cancelled')
    expect(job.items.slice(1).map((i) => i.status)).toEqual(['not_processed', 'not_processed'])
    expect(['draft', 'active']).toContain(job.items[0]?.status)
    expect(job.report).toMatchObject({ total: 3, not_processed: 2 })
  })

  it('stops when the budget is spent: the rest is not_processed', async () => {
    const id = await importCsv(
      `Title,Steps,Expected
Open the cart,Tap the cart icon,"""My Cart"" shows"
Open the menu,Tap the menu icon,"""Log In"" shows"
`,
      { max_cost_usd: 0.01 },
    )
    const job = await until(id, ended)
    expect(job.status).toBe('cancelled')
    expect(job.items[1]?.status).toBe('not_processed')
  })
})

describe('fixtures/manual/mydemo-10.csv (US6 DoD, SC-004)', { timeout: 300_000 }, () => {
  beforeAll(async () => {
    await server.close()
    server = await startRunServer({
      explorer: {},
      secrets: { TEST_USER: 'bod@example.com', TEST_PASSWORD: '10203040' },
    })
    huynh = await server.newUser('Mai')
    project = await sampleProject(server, huynh)
    const found = await sampleDevice(server, huynh, 'imports-mydemo')
    agents.push(found.sample)
    deviceId = found.deviceId
    void answerJobs(found.sample.agent)
  })

  it('makes 7 of the 10 cases active, the others draft with why', async () => {
    const csv = readFileSync(new URL('../../../../fixtures/manual/mydemo-10.csv', import.meta.url))
    const id = await importCsv(csv.toString('utf8'))
    const job = await until(id, ended, 240_000)
    expect(job.status).toBe('done')
    expect(job.items.map((i) => [i.n, i.status, i.reason])).toEqual([
      [1, 'active', null],
      [2, 'active', null],
      [3, 'active', null],
      [4, 'active', null],
      [5, 'active', null],
      [6, 'active', null],
      [7, 'active', null],
      [8, 'draft', 'needs_human'],
      [9, 'draft', 'ambiguous'],
      [10, 'draft', 'app_mismatch'],
    ])
    expect(job.report).toMatchObject({ total: 10, active: 7, not_processed: 0 })
    // The demo login typed the secrets by name: no value in its test case.
    const testCases = testCasesRepo(
      server.db,
      huynh.tenantId,
      server.store,
      projectsRepo(server.db, huynh.tenantId, server.store),
    )
    const login = await testCases.get(job.items[2]?.test_case_id ?? '')
    const yaml = await testCases.readYaml(login)
    expect(yaml).toContain('${secret:TEST_USER}')
    expect(yaml).not.toContain('10203040')
  })
})
