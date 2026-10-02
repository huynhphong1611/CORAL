import type { protocol } from '@coral/shared'
import { api, newId } from '@coral/shared'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { devices, runs } from '../db/schema'
import { projectsRepo } from '../repos/projects'
import { testCasesRepo } from '../repos/test-cases'
import { envSecrets } from '../runs/secrets'
import { fakeAgent } from '../testing/fake-agent'
import { LOGIN_YAML, startRunServer, type RunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'
import { ValidationService } from './validation'

// US3 (T040, research R13): two validation runs in a row per test case through the dispatcher;
// a scripted agent passes or fails them.
let server: RunServer
let huynh: TestUser
let fixture: Awaited<ReturnType<RunServer['seed']>>
let agent: Awaited<ReturnType<typeof fakeAgent>>
let deviceId = ''
let validation: ValidationService

/** What the agent answers for a test case: its slug → item result of each attempt. */
const script = new Map<string, ('passed' | 'failed')[]>()
/** Called once per job before it is answered (a test edits a test case in between). */
let beforeAnswer: ((job: protocol.Payload<'job.assign'>) => Promise<void>) | undefined

beforeAll(async () => {
  server = await startRunServer({ secrets: { TEST_USER: 'bob@example.com' } })
  huynh = await server.newUser('Huynh')
  fixture = await server.seed(huynh)
  agent = await fakeAgent(server.url, fixture.agent.token)
  const [row] = await server.db.select().from(devices).where(eq(devices.agentId, fixture.agent.id))
  deviceId = row?.id ?? ''
  validation = new ValidationService({
    db: server.db,
    store: server.store,
    secrets: envSecrets({ CORAL_SECRET_TEST_USER: 'bob@example.com' }),
    queue: server.dispatcher,
    pollMs: 50,
  })
  void answerJobs()
})
afterAll(async () => {
  agent.close()
  await server.close()
})

/** Answers every job.assign: ack, then each item as the script says (passed by default). */
async function answerJobs() {
  const attempts = new Map<string, number>()
  for (;;) {
    let job
    try {
      job = await agent.nextJob(600_000)
    } catch {
      return
    }
    agent.ack(job)
    await beforeAnswer?.(job.payload)
    for (const item of job.payload.items) {
      const slug = /^id:\s*(\S+)/m.exec(item.yaml)?.[1] ?? ''
      const n = (attempts.get(slug) ?? 0) + 1
      attempts.set(slug, n)
      const status = script.get(slug)?.[n - 1] ?? 'passed'
      agent.item(
        job.payload,
        item.run_item_id,
        status,
        status === 'failed' ? { failure_code: 'EXPECT_FAILED', failed_step_id: 's2' } : {},
      )
    }
    agent.done(job.payload, 'passed')
  }
}

async function testCase(slug: string) {
  const res = await server.call(huynh, {
    method: 'POST',
    url: `/projects/${fixture.project.id}/testcases`,
    payload: { yaml: LOGIN_YAML.replace('id: login', `id: ${slug}`) },
  })
  return api.savedTestCaseSchema.parse(res.body).id
}

const repo = () =>
  testCasesRepo(
    server.db,
    huynh.tenantId,
    server.store,
    projectsRepo(server.db, huynh.tenantId, server.store),
  )

const validate = (testCaseIds: string[]) =>
  validation.validate({
    tenantId: huynh.tenantId,
    projectId: fixture.project.id,
    buildId: fixture.build.id,
    deviceId,
    userId: huynh.userId,
    testCaseIds,
  })

describe('validation of written test cases (US3, T040)', { timeout: 60_000 }, () => {
  it('makes a test case active after two passed runs, and keeps a failing one draft', async () => {
    const good = await testCase(`good-${newId().slice(-6)}`)
    const flaky = await testCase(`flaky-${newId().slice(-6)}`)
    const flagged = await testCase(`flagged-${newId().slice(-6)}`)
    script.set((await repo().get(flaky)).slug, ['passed', 'failed'])
    await repo().setStatus(flagged, { status: 'draft', flags: ['needs_review_never_tap'] })

    expect(await validate([good, flaky, flagged])).toBe(1)

    const passed = await repo().get(good)
    expect(passed).toMatchObject({ status: 'active', draftReason: null })
    expect(passed.validatedAt).toBeInstanceOf(Date)
    expect(passed.validation).toMatchObject({
      commit: passed.headCommit,
      runs: [{ status: 'passed' }, { status: 'passed' }],
    })
    // Both were validation runs of that test case, one after the other.
    const made = await server.db.select().from(runs).where(eq(runs.validationOf, good))
    expect(made.map((r) => r.trigger)).toEqual(['validation', 'validation'])

    const failed = await repo().get(flaky)
    expect(failed).toMatchObject({
      status: 'draft',
      draftReason: 'validation_failed',
      validation: {
        runs: [
          { status: 'passed' },
          { status: 'failed', failure_code: 'EXPECT_FAILED', step_id: 's2' },
        ],
      },
    })
    // Flagged for review: no run at all.
    expect(await repo().get(flagged)).toMatchObject({ status: 'draft', validation: null })
    expect(
      await server.db
        .select()
        .from(runs)
        .where(and(eq(runs.validationOf, flagged))),
    ).toEqual([])
  })

  it('keeps it draft when the test case changed while it was validated', async () => {
    const id = await testCase(`edited-${newId().slice(-6)}`)
    let edited = false
    beforeAnswer = async () => {
      if (edited) return
      edited = true
      const current = await repo().get(id)
      const yaml = await repo().readYaml(current)
      const res = await server.call(huynh, {
        method: 'PUT',
        url: `/testcases/${id}`,
        payload: {
          yaml: yaml.replace("intent: 'Đăng nhập'", "intent: 'Đăng nhập lại'"),
          base_commit: current.headCommit,
        },
      })
      expect(res.status).toBe(200)
    }
    expect(await validate([id])).toBe(0)
    beforeAnswer = undefined
    expect(await repo().get(id)).toMatchObject({
      status: 'draft',
      draftReason: 'changed_during_validation',
    })
  })
})
