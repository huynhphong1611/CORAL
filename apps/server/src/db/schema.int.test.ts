import { newId } from '@coral/shared'
import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../config'
import { createDatabase } from './client'
import {
  BUSINESS_TABLES,
  agents,
  apps,
  brainCalls,
  builds,
  deviceCommands,
  devices,
  explorationSteps,
  explorations,
  importItems,
  importJobs,
  leases,
  liveSessions,
  projects,
  runs,
  tenants,
  testCases,
  toolCalls,
  users,
} from './schema'

const database = createDatabase(loadConfig(process.env).databaseUrl)
const { db } = database
afterAll(() => database.close())

async function seedDevice() {
  const [tenant] = await db
    .insert(tenants)
    .values({ name: `t-${newId()}` })
    .returning()
  if (!tenant) throw new Error('no tenant')
  const [agent] = await db
    .insert(agents)
    .values({ tenantId: tenant.id, name: 'laptop', tokenHash: newId() })
    .returning()
  if (!agent) throw new Error('no agent')
  const [device] = await db
    .insert(devices)
    .values({
      tenantId: tenant.id,
      agentId: agent.id,
      platform: 'android',
      kind: 'emulator',
      model: 'sdk_gphone64',
      osVersion: '14',
      apiLevel: 34,
      udid: 'emulator-5554',
    })
    .returning()
  if (!device) throw new Error('no device')
  return { tenantId: tenant.id, deviceId: device.id }
}

const lease = (tenantId: string, deviceId: string, kind: 'run' | 'live' | 'recording' = 'run') => ({
  tenantId,
  deviceId,
  kind,
  holderRef: `${kind}:${newId()}`,
  expiresAt: new Date(Date.now() + 60_000),
})

describe('Phase 1 schema (data-model.md)', () => {
  it('gives every business table a non-null tenant_id (P5)', async () => {
    const { rows } = await db.execute<{ table_name: string; is_nullable: string }>(sql`
      select table_name, is_nullable from information_schema.columns
      where table_schema = 'public' and column_name = 'tenant_id'`)
    const byTable = new Map(rows.map((r) => [r.table_name, r.is_nullable]))
    for (const table of BUSINESS_TABLES) expect(byTable.get(table), table).toBe('NO')
    for (const global of ['users', 'refresh_tokens']) expect(byTable.has(global)).toBe(false)
  })

  it('allows only one open lease per device (D16, SC-007)', async () => {
    const { tenantId, deviceId } = await seedDevice()
    await db.insert(leases).values(lease(tenantId, deviceId))
    await expect(db.insert(leases).values(lease(tenantId, deviceId))).rejects.toThrow()
  })

  it('allows a new lease once the previous one is released', async () => {
    const { tenantId, deviceId } = await seedDevice()
    const [first] = await db.insert(leases).values(lease(tenantId, deviceId)).returning()
    await db
      .update(leases)
      .set({ releasedAt: new Date(), releaseReason: 'done' })
      .where(sql`${leases.id} = ${first?.id}`)
    await expect(db.insert(leases).values(lease(tenantId, deviceId))).resolves.toBeDefined()
  })

  it('rejects values outside the documented enums', async () => {
    const { tenantId, deviceId } = await seedDevice()
    await expect(
      db.execute(
        sql`update devices set status = 'broken' where id = ${deviceId} and tenant_id = ${tenantId}`,
      ),
    ).rejects.toMatchObject({ cause: { constraint: 'devices_status' } })
  })
})

describe('Phase 2 schema (specs/003-phase-2-web-recorder/data-model.md)', () => {
  async function seedUser() {
    const [user] = await db
      .insert(users)
      .values({ email: `u-${newId()}@coral.test`, passwordHash: 'x', name: 'Huynh' })
      .returning()
    if (!user) throw new Error('no user')
    return user.id
  }

  it('never lets a control session or a recording share a device with a run (SC-006)', async () => {
    for (const second of ['live', 'recording'] as const) {
      const { tenantId, deviceId } = await seedDevice()
      await db.insert(leases).values(lease(tenantId, deviceId, 'run'))
      await expect(db.insert(leases).values(lease(tenantId, deviceId, second))).rejects.toThrow()
    }
  })

  it('keeps one open live session per device', async () => {
    const { tenantId, deviceId } = await seedDevice()
    const userId = await seedUser()
    const [held] = await db
      .insert(leases)
      .values(lease(tenantId, deviceId, 'live'))
      .returning()
    if (!held) throw new Error('no lease')
    const session = { tenantId, deviceId, userId, leaseId: held.id }
    await db.insert(liveSessions).values(session)
    await expect(db.insert(liveSessions).values(session)).rejects.toThrow()
  })

  it('rejects unknown command kinds and statuses (FR-009)', async () => {
    const { tenantId, deviceId } = await seedDevice()
    const userId = await seedUser()
    await expect(
      db
        .insert(deviceCommands)
        .values({ tenantId, deviceId, userId, kind: 'tap', params: { x: 1, y: 2 } }),
    ).resolves.toBeDefined()
    await expect(
      db.execute(
        sql`insert into device_commands (id, tenant_id, device_id, user_id, kind) values (${newId()}, ${tenantId}, ${deviceId}, ${userId}, 'shell')`,
      ),
    ).rejects.toMatchObject({ cause: { constraint: 'device_commands_kind' } })
    await db.insert(leases).values(lease(tenantId, deviceId, 'recording'))
    await expect(
      db.execute(sql`update leases set kind = 'party' where device_id = ${deviceId}`),
    ).rejects.toMatchObject({ cause: { constraint: 'leases_kind' } })
  })
})

describe('Phase 3 schema (specs/004-phase-3-brain-explorer/data-model.md)', () => {
  /** A tenant with a project, app, build, device and user: what an exploration points to. */
  async function seedExplorable() {
    const { tenantId, deviceId } = await seedDevice()
    const [user] = await db
      .insert(users)
      .values({ email: `u-${newId()}@coral.test`, passwordHash: 'x', name: 'Huynh' })
      .returning()
    const [project] = await db
      .insert(projects)
      .values({ tenantId, name: 'shop', gitRepoPath: '/tmp/x' })
      .returning()
    if (!user || !project) throw new Error('seed failed')
    const [app] = await db
      .insert(apps)
      .values({
        tenantId,
        projectId: project.id,
        platform: 'android',
        packageOrBundleId: 'com.example.shop',
        name: 'Shop',
      })
      .returning()
    if (!app) throw new Error('no app')
    const [build] = await db
      .insert(builds)
      .values({
        tenantId,
        appId: app.id,
        version: '1.0',
        artifactKey: 'k',
        checksumSha256: 'a'.repeat(64),
        sizeBytes: 1,
      })
      .returning()
    if (!build) throw new Error('no build')
    return {
      tenantId,
      deviceId,
      userId: user.id,
      projectId: project.id,
      appId: app.id,
      buildId: build.id,
    }
  }

  async function seedExploration() {
    const seed = await seedExplorable()
    const [exploration] = await db
      .insert(explorations)
      .values({
        tenantId: seed.tenantId,
        projectId: seed.projectId,
        appId: seed.appId,
        buildId: seed.buildId,
        deviceId: seed.deviceId,
        userId: seed.userId,
        kind: 'explore',
        budget: { max_steps: 60, max_depth: 8, max_minutes: 20, max_cost_usd: 3 },
        maxTests: 5,
      })
      .returning()
    if (!exploration) throw new Error('no exploration')
    return { ...seed, explorationId: exploration.id, exploration }
  }

  const rejects = (query: ReturnType<typeof sql>, constraint: string) =>
    expect(db.execute(query)).rejects.toMatchObject({ cause: { constraint } })

  it('starts an exploration queued with empty stats', async () => {
    const { exploration } = await seedExploration()
    expect(exploration).toMatchObject({ status: 'queued', stopReason: null, goal: null })
    expect(exploration.stats).toMatchObject({ steps: 0, cost_usd: 0, tests_active: 0 })
  })

  it('rejects exploration values outside the data model', async () => {
    const { explorationId: id } = await seedExploration()
    await rejects(sql`update explorations set kind = 'roam' where id = ${id}`, 'explorations_kind')
    await rejects(
      sql`update explorations set status = 'paused' where id = ${id}`,
      'explorations_status',
    )
    await rejects(
      sql`update explorations set stop_reason = 'tired' where id = ${id}`,
      'explorations_stop_reason',
    )
    await rejects(
      sql`update explorations set max_tests = 21 where id = ${id}`,
      'explorations_max_tests',
    )
    await expect(
      db.execute(
        sql`update explorations set status = 'done', stop_reason = 'goal_not_reached' where id = ${id}`,
      ),
    ).resolves.toBeDefined()
  })

  it('numbers trace steps once per exploration and checks their values', async () => {
    const { tenantId, explorationId } = await seedExploration()
    const step = {
      tenantId,
      explorationId,
      n: 1,
      segment: 1,
      fingerprint: '9f2c4e71a0b3d5e8',
      status: 'done' as const,
      decision: { action: 'back', reason: 'x' },
      flags: ['invented_text' as const],
      costUsd: 0.000123,
    }
    const [row] = await db.insert(explorationSteps).values(step).returning()
    expect(row?.costUsd).toBe(0.000123)
    await expect(db.insert(explorationSteps).values(step)).rejects.toThrow()
    await expect(db.insert(explorationSteps).values({ ...step, n: 2 })).resolves.toBeDefined()
    const id = row?.id
    await rejects(
      sql`update exploration_steps set status = 'skipped' where id = ${id}`,
      'exploration_steps_status',
    )
    await rejects(
      sql`update exploration_steps set refusal = 'rude' where id = ${id}`,
      'exploration_steps_refusal',
    )
    await rejects(
      sql`update exploration_steps set flags = array['never_tap', 'shiny'] where id = ${id}`,
      'exploration_steps_flags',
    )
  })

  it('records AI calls with their errors and the tools they used', async () => {
    const { tenantId, explorationId } = await seedExploration()
    const [call] = await db
      .insert(brainCalls)
      .values({
        tenantId,
        role: 'explorer',
        provider: 'fake',
        model: 'fake',
        attempt: 1,
        tokensIn: 1200,
        tokensOut: 40,
        costUsd: 0.0016,
        ok: false,
        error: 'rate_limited',
        refType: 'exploration',
        refId: explorationId,
      })
      .returning()
    if (!call) throw new Error('no call')
    await db.insert(toolCalls).values({
      tenantId,
      brainCallId: call.id,
      mcpServer: 'otp',
      tool: 'send_sms',
      ok: false,
      blocked: true,
      error: 'side_effects_disabled',
    })
    await rejects(
      sql`update brain_calls set role = 'healer' where id = ${call.id}`,
      'brain_calls_role',
    )
    await rejects(
      sql`update brain_calls set error = 'oops' where id = ${call.id}`,
      'brain_calls_error',
    )
    await rejects(
      sql`update brain_calls set ref_type = 'run' where id = ${call.id}`,
      'brain_calls_ref_type',
    )
    await rejects(
      sql`update brain_calls set attempt = 0 where id = ${call.id}`,
      'brain_calls_attempt',
    )
    await rejects(
      sql`update tool_calls set error = 'nope' where brain_call_id = ${call.id}`,
      'tool_calls_error',
    )
  })

  it('numbers import items once per job and checks job and item values', async () => {
    const seed = await seedExplorable()
    const [job] = await db
      .insert(importJobs)
      .values({
        tenantId: seed.tenantId,
        projectId: seed.projectId,
        createdBy: seed.userId,
        sourceFormat: 'csv',
        fileName: 'cases.csv',
      })
      .returning()
    if (!job) throw new Error('no job')
    expect(job).toMatchObject({ status: 'preview', stats: { total: 0 } })
    const item = {
      tenantId: seed.tenantId,
      importJobId: job.id,
      n: 1,
      manualPath: `imports/${job.id}/001-login.yaml`,
      title: 'Login',
    }
    await db.insert(importItems).values(item)
    await expect(db.insert(importItems).values(item)).rejects.toThrow()
    await rejects(
      sql`update import_jobs set source_format = 'docx' where id = ${job.id}`,
      'import_jobs_source_format',
    )
    await rejects(
      sql`update import_jobs set status = 'paused' where id = ${job.id}`,
      'import_jobs_status',
    )
    await rejects(
      sql`update import_items set status = 'skipped' where import_job_id = ${job.id}`,
      'import_items_status',
    )
    await rejects(
      sql`update import_items set reason = 'bored' where import_job_id = ${job.id}`,
      'import_items_reason',
    )
  })

  it('stores AI-written test cases with draft reason, flags and their validation runs', async () => {
    const seed = await seedExplorable()
    const [testCase] = await db
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
        draftReason: 'needs_human',
        flags: ['needs_review_never_tap'],
      })
      .returning()
    if (!testCase) throw new Error('no test case')
    expect(testCase).toMatchObject({ validation: null, validatedAt: null })
    const id = testCase.id
    await rejects(
      sql`update test_cases set draft_reason = 'lazy' where id = ${id}`,
      'test_cases_draft_reason',
    )
    await rejects(
      sql`update test_cases set flags = array['shiny'] where id = ${id}`,
      'test_cases_flags',
    )
    await rejects(sql`update test_cases set source = 'magic' where id = ${id}`, 'test_cases_source')
    const [run] = await db
      .insert(runs)
      .values({
        tenantId: seed.tenantId,
        projectId: seed.projectId,
        buildId: seed.buildId,
        deviceId: seed.deviceId,
        trigger: 'validation',
        popupsCommit: 'abc1234',
        validationOf: id,
      })
      .returning()
    expect(run?.validationOf).toBe(id)
    await expect(
      db.execute(sql`update runs set validation_of = ${newId()} where id = ${run?.id}`),
    ).rejects.toThrow()
  })

  it('lets an exploration hold the device like any other lease', async () => {
    const { tenantId, deviceId, explorationId } = await seedExploration()
    const [held] = await db
      .insert(leases)
      .values({
        ...lease(tenantId, deviceId),
        kind: 'exploration',
        holderRef: `exploration:${explorationId}`,
      })
      .returning()
    await db
      .update(explorations)
      .set({ leaseId: held?.id, status: 'running' })
      .where(sql`${explorations.id} = ${explorationId}`)
    await expect(db.insert(leases).values(lease(tenantId, deviceId, 'live'))).rejects.toThrow()
  })
})
