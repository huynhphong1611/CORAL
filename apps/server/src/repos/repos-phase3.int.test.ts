import { newId } from '@coral/shared'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../config'
import { createDatabase } from '../db/client'
import {
  agents,
  apps,
  brainCalls,
  builds,
  devices,
  leases,
  projects,
  tenants,
  testCases,
  users,
} from '../db/schema'
import { brainCallsRepo, utcDayStart } from './brain-calls'
import { explorationHolder, explorationsRepo } from './explorations'
import { importsRepo } from './imports'
import { testCasesRepo } from './test-cases'

const database = createDatabase(loadConfig(process.env).databaseUrl)
const { db } = database
afterAll(() => database.close())

const one = <T>(rows: T[]): T => {
  const [row] = rows
  if (!row) throw new Error('nothing inserted')
  return row
}

/** A tenant with a user, project, app, build and an idle device. */
async function seedTenant() {
  const tenant = one(
    await db
      .insert(tenants)
      .values({ name: `t-${newId()}` })
      .returning(),
  )
  const tenantId = tenant.id
  const user = one(
    await db
      .insert(users)
      .values({ email: `u-${newId()}@coral.test`, passwordHash: 'x', name: 'Huynh' })
      .returning(),
  )
  const project = one(
    await db.insert(projects).values({ tenantId, name: 'shop', gitRepoPath: '/tmp/x' }).returning(),
  )
  const app = one(
    await db
      .insert(apps)
      .values({
        tenantId,
        projectId: project.id,
        platform: 'android',
        packageOrBundleId: 'com.example.shop',
        name: 'Shop',
      })
      .returning(),
  )
  const build = one(
    await db
      .insert(builds)
      .values({
        tenantId,
        appId: app.id,
        version: '1.0',
        artifactKey: 'k',
        checksumSha256: 'a'.repeat(64),
        sizeBytes: 1,
      })
      .returning(),
  )
  const agent = one(
    await db.insert(agents).values({ tenantId, name: 'laptop', tokenHash: newId() }).returning(),
  )
  const device = one(
    await db
      .insert(devices)
      .values({
        tenantId,
        agentId: agent.id,
        platform: 'android',
        kind: 'emulator',
        model: 'sdk_gphone64',
        osVersion: '14',
        udid: 'emulator-5554',
        status: 'idle',
      })
      .returning(),
  )
  return {
    tenantId,
    userId: user.id,
    projectId: project.id,
    appId: app.id,
    buildId: build.id,
    deviceId: device.id,
  }
}

type Seed = Awaited<ReturnType<typeof seedTenant>>

const newExploration = (seed: Seed) => ({
  projectId: seed.projectId,
  appId: seed.appId,
  buildId: seed.buildId,
  deviceId: seed.deviceId,
  userId: seed.userId,
  kind: 'explore' as const,
  budget: { max_steps: 60, max_depth: 8, max_minutes: 20, max_cost_usd: 3 },
  maxTests: 5,
  leaseTtlMs: 60_000,
})

const call = (refId: string, costUsd: number, createdAt?: Date) => ({
  role: 'explorer' as const,
  provider: 'fake',
  model: 'fake',
  attempt: 1,
  tokensIn: 1000,
  tokensOut: 50,
  costUsd,
  ok: true,
  refType: 'exploration' as const,
  refId,
  ...(createdAt ? { createdAt } : {}),
})

describe('explorations repo (T013)', () => {
  it('holds the device from creation and refuses a busy device', async () => {
    const seed = await seedTenant()
    const repo = explorationsRepo(db, seed.tenantId)
    const exploration = await repo.create(newExploration(seed))
    expect(exploration).toMatchObject({ status: 'queued', userName: 'Huynh', kind: 'explore' })
    const [lease] = await db
      .select()
      .from(leases)
      .where(eq(leases.holderRef, explorationHolder(exploration?.id ?? '')))
    expect(lease).toMatchObject({ kind: 'exploration', releasedAt: null })
    const [device] = await db.select().from(devices).where(eq(devices.id, seed.deviceId))
    expect(device?.status).toBe('leased')
    expect(await repo.create(newExploration(seed))).toBeUndefined()
  })

  it('moves status only from the expected states and pages the trace', async () => {
    const seed = await seedTenant()
    const repo = explorationsRepo(db, seed.tenantId)
    const { id } = (await repo.create(newExploration(seed))) ?? { id: '' }
    expect(await repo.update(id, { status: 'running', startedAt: new Date() }, ['queued'])).toBe(
      true,
    )
    expect(await repo.update(id, { status: 'running' }, ['queued'])).toBe(false)
    for (const n of [1, 2, 3]) {
      await repo.addStep(id, {
        n,
        segment: 1,
        fingerprint: n === 3 ? 'bbbbbbbbbbbbbbbb' : 'aaaaaaaaaaaaaaaa',
        status: n === 2 ? 'refused' : 'done',
        refusal: n === 2 ? 'never_tap' : null,
        decision: { action: 'tap', element: n, reason: 'try it' },
        flags: n === 2 ? ['never_tap'] : [],
        costUsd: 0.001,
      })
    }
    await expect(
      repo.addStep(id, { n: 3, segment: 1, fingerprint: 'cccccccccccccccc', status: 'done' }),
    ).rejects.toThrow()
    await repo.setStepScreen(id, 'aaaaaaaaaaaaaaaa', 'catalog')
    const page = await repo.steps(id, { after: 1, limit: 1 })
    expect(page.map((s) => [s.n, s.screenId, s.refusal])).toEqual([[2, 'catalog', 'never_tap']])
    expect((await repo.steps(id)).map((s) => s.screenId)).toEqual(['catalog', 'catalog', null])
    await repo.addFinding({ explorationId: id, stepN: 3, kind: 'crashed', logExcerpt: 'FATAL' })
    expect(await repo.findings(id)).toMatchObject([{ stepN: 3, kind: 'crashed' }])
  })

  it('never shows one tenant the explorations, steps or findings of another (P5)', async () => {
    const a = await seedTenant()
    const b = await seedTenant()
    const repoA = explorationsRepo(db, a.tenantId)
    const repoB = explorationsRepo(db, b.tenantId)
    const { id } = (await repoA.create(newExploration(a))) ?? { id: '' }
    await repoA.addStep(id, { n: 1, segment: 1, fingerprint: 'aaaaaaaaaaaaaaaa', status: 'done' })
    await repoA.addFinding({ explorationId: id, stepN: 1, kind: 'crashed', logExcerpt: '' })
    await expect(repoB.get(id)).rejects.toMatchObject({ status: 404 })
    expect(await repoB.list({ projectId: a.projectId })).toEqual([])
    expect(await repoB.steps(id)).toEqual([])
    expect(await repoB.findings(id)).toEqual([])
    await expect(
      repoB.addStep(id, { n: 2, segment: 1, fingerprint: 'aaaaaaaaaaaaaaaa', status: 'done' }),
    ).rejects.toMatchObject({ status: 404 })
    expect(await repoB.update(id, { status: 'failed' })).toBe(false)
    expect((await repoA.get(id)).status).toBe('queued')
  })
})

describe('brain calls repo (T013)', () => {
  it('sums the cost of a UTC day, also across midnight', async () => {
    const seed = await seedTenant()
    const repo = brainCallsRepo(db, seed.tenantId)
    const ref = newId()
    const midnight = new Date('2026-10-02T00:00:00.000Z')
    await repo.record(call(ref, 0.5, new Date(midnight.getTime() - 60_000)))
    await repo.record(call(ref, 0.25, midnight))
    await repo.record(call(ref, 0.125, new Date(midnight.getTime() + 60_000)))
    expect(await repo.costOfDay(new Date('2026-10-01T12:00:00.000Z'))).toBeCloseTo(0.5)
    expect(await repo.costOfDay(new Date('2026-10-02T23:59:59.000Z'))).toBeCloseTo(0.375)
    expect(utcDayStart(new Date('2026-10-02T23:59:59.000Z'))).toEqual(midnight)
    expect(await repo.costOf('exploration', ref)).toBeCloseTo(0.875)
    expect(await repo.costOf('import_job', ref)).toBe(0)
    const byDay = await repo.usage({ from: '2026-10-01', to: '2026-10-02', group: 'day' })
    expect(byDay.map((r) => [r.key, r.calls, r.cost_usd])).toEqual([
      ['2026-10-01', 1, 0.5],
      ['2026-10-02', 2, 0.375],
    ])
    const byProvider = await repo.usage({ from: '2026-10-02', group: 'provider' })
    expect(byProvider).toMatchObject([{ key: 'fake', calls: 2, tokens_in: 2000, tokens_out: 100 }])
  })

  it('keeps tool calls with their brain call and the content key', async () => {
    const seed = await seedTenant()
    const repo = brainCallsRepo(db, seed.tenantId)
    const brainCall = await repo.record({ ...call(newId(), 0.01), ok: false, error: 'timeout' })
    await repo.setContentKey(brainCall.id, `${seed.tenantId}/ai/exploration/x/${brainCall.id}.json`)
    await repo.recordTool({
      brainCallId: brainCall.id,
      mcpServer: 'otp',
      tool: 'get_otp',
      ok: true,
    })
    await repo.recordTool({
      brainCallId: brainCall.id,
      mcpServer: 'otp',
      tool: 'send_sms',
      ok: false,
      blocked: true,
      error: 'side_effects_disabled',
    })
    expect(await repo.get(brainCall.id)).toMatchObject({ error: 'timeout', contentKey: /\.json$/ })
    expect((await repo.toolCalls([brainCall.id])).map((t) => [t.tool, t.blocked])).toEqual([
      ['get_otp', false],
      ['send_sms', true],
    ])
  })

  it('never counts or shows the calls of another tenant (P5)', async () => {
    const a = await seedTenant()
    const b = await seedTenant()
    const ref = newId()
    const brainCall = await brainCallsRepo(db, a.tenantId).record(call(ref, 2))
    await brainCallsRepo(db, a.tenantId).recordTool({
      brainCallId: brainCall.id,
      mcpServer: 'otp',
      tool: 'get_otp',
      ok: true,
    })
    const repoB = brainCallsRepo(db, b.tenantId)
    expect(await repoB.costOfDay()).toBe(0)
    expect(await repoB.costOf('exploration', ref)).toBe(0)
    expect(await repoB.usage({ group: 'role' })).toEqual([])
    expect(await repoB.toolCalls([brainCall.id])).toEqual([])
    await expect(repoB.get(brainCall.id)).rejects.toMatchObject({ status: 404 })
    const rows = await db.select().from(brainCalls).where(eq(brainCalls.id, brainCall.id))
    expect(rows).toHaveLength(1)
  })
})

describe('imports repo (T013)', () => {
  async function seedJob() {
    const seed = await seedTenant()
    const repo = importsRepo(db, seed.tenantId)
    const job = await repo.createJob({
      projectId: seed.projectId,
      createdBy: seed.userId,
      sourceFormat: 'csv',
      fileName: 'cases.csv',
    })
    return { seed, repo, job }
  }

  it('resumes from the first pending case after a restart', async () => {
    const { repo, job } = await seedJob()
    expect(job).toMatchObject({ status: 'preview', createdByName: 'Huynh' })
    await repo.addItems(
      job.id,
      [1, 2, 3].map((n) => ({ n, manualPath: `imports/${job.id}/00${n}-c.yaml`, title: `C${n}` })),
    )
    expect(await repo.updateJob(job.id, { status: 'running' }, ['preview'])).toBe(true)
    await repo.updateItem(job.id, 1, { status: 'active', costUsd: 0.4 })
    await repo.updateItem(job.id, 2, { status: 'running', explorationId: null })
    expect(await repo.requeueRunning(job.id)).toBe(1)
    expect((await repo.nextPending(job.id))?.n).toBe(2)
    expect(await repo.markNotProcessed(job.id)).toBe(2)
    expect((await repo.items(job.id)).map((i) => i.status)).toEqual([
      'active',
      'not_processed',
      'not_processed',
    ])
    expect(await repo.nextPending(job.id)).toBeUndefined()
    // Only a job in preview can be deleted.
    expect(await repo.deletePreview(job.id)).toBe(false)
  })

  it('deletes a preview with its items and never shows another tenant the job (P5)', async () => {
    const { repo, job } = await seedJob()
    await repo.addItems(job.id, [{ n: 1, manualPath: 'imports/x/001-a.yaml', title: 'A' }])
    const other = await seedTenant()
    const repoB = importsRepo(db, other.tenantId)
    await expect(repoB.getJob(job.id)).rejects.toMatchObject({ status: 404 })
    expect(await repoB.items(job.id)).toEqual([])
    expect(await repoB.deletePreview(job.id)).toBe(false)
    await expect(
      repoB.addItems(job.id, [{ n: 2, manualPath: 'imports/x/002-b.yaml', title: 'B' }]),
    ).rejects.toMatchObject({ status: 404 })
    expect(await repo.deletePreview(job.id)).toBe(true)
    await expect(repo.getJob(job.id)).rejects.toMatchObject({ status: 404 })
  })
})

describe('test case status columns (T013)', () => {
  it('stores validation results and clears the draft reason on activation', async () => {
    const seed = await seedTenant()
    const row = one(
      await db
        .insert(testCases)
        .values({
          tenantId: seed.tenantId,
          projectId: seed.projectId,
          slug: 'open-menu',
          pathInRepo: 'testcases/open-menu.yaml',
          intent: 'Open the menu',
          platforms: ['android'],
          headCommit: 'abc1234',
          source: 'ai_explore',
          draftReason: 'validation_failed',
        })
        .returning(),
    )
    expect(row.flags).toEqual([])
    // setStatus touches only the index row: no git store or project lookup involved.
    const repo = testCasesRepo(db, seed.tenantId, {} as never, {} as never)
    const validation = { commit: 'abc1234', runs: [{ run_id: newId(), status: 'passed' as const }] }
    const active = await repo.setStatus(row.id, {
      status: 'active',
      validation,
      validatedAt: new Date(),
    })
    expect(active).toMatchObject({ status: 'active', draftReason: null, validation })
    const other = testCasesRepo(db, (await seedTenant()).tenantId, {} as never, {} as never)
    await expect(other.setStatus(row.id, { status: 'quarantined' })).rejects.toMatchObject({
      status: 404,
    })
  })
})
