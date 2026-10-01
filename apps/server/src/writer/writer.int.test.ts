import { findAll } from '@coral/runner'
import { SAMPLE_APP } from '@coral/runner/testing'
import { elementTreeSchema, validateTestCaseSource, type ElementNode } from '@coral/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { explorationsRepo, type ExplorationRow } from '../repos/explorations'
import { projectsRepo } from '../repos/projects'
import { testCasesRepo } from '../repos/test-cases'
import type { DeviceAgent } from '../testing/device-agent'
import { startRunServer, type RunServer } from '../testing/run-server'
import { sampleDevice, sampleProject } from '../testing/sample-project'
import type { TestUser } from '../testing/test-server'

// US3 (T039): after an exploration the writer saves draft test cases — one commit each, YAML
// valid and self-contained, every locator found in its step's snapshot, duplicates left out.
const SECRET = 'bob@example.com'
let server: RunServer
let huynh: TestUser
const agents: DeviceAgent[] = []

beforeAll(async () => {
  server = await startRunServer({ explorer: { validate: false }, secrets: { TEST_USER: SECRET } })
  huynh = await server.newUser('Huynh')
})
afterAll(async () => {
  for (const agent of agents) agent.close()
  await server.close()
})

async function explore(project: Awaited<ReturnType<typeof sampleProject>>, deviceId: string) {
  const repo = explorationsRepo(server.db, huynh.tenantId)
  const started = await server.explorations.start(
    { tenantId: huynh.tenantId, userId: huynh.userId },
    {
      project_id: project.project.id,
      app_id: project.app.id,
      build_id: project.build.id,
      device_id: deviceId,
      budget: { max_steps: 16 },
    },
  )
  const deadline = Date.now() + 60_000
  for (;;) {
    const row = await repo.get(started.id)
    if (['done', 'stopped', 'failed', 'interrupted'].includes(row.status)) return row
    if (Date.now() > deadline) throw new Error(`exploration still ${row.status}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('Test writer (US3, T039)', { timeout: 120_000 }, () => {
  let first: ExplorationRow

  it('writes draft test cases from the trace, one commit each with their snapshots', async () => {
    const project = await sampleProject(server, huynh)
    const { sample, deviceId } = await sampleDevice(server, huynh, 'writer-1')
    agents.push(sample)
    first = await explore(project, deviceId)
    expect(first).toMatchObject({ status: 'done', stopReason: 'max_steps' })

    const projects = projectsRepo(server.db, huynh.tenantId, server.store)
    const testCases = testCasesRepo(server.db, huynh.tenantId, server.store, projects)
    const written = await testCases.list(project.project.id, {
      sourceRef: `exploration:${first.id}`,
    })
    expect(written.length).toBeGreaterThanOrEqual(3)
    expect(written.length).toBeLessThanOrEqual(first.maxTests)
    expect(first.stats.tests_written).toBe(written.length)
    for (const row of written) {
      expect(row).toMatchObject({ source: 'ai_explore', status: 'draft', flags: [] })
      const yaml = await testCases.readYaml(row)
      expect(yaml).not.toContain(SECRET)
      const parsed = validateTestCaseSource(yaml, row.pathInRepo)
      expect(parsed.errors).toEqual([])
      const testCase = parsed.value
      if (!testCase) throw new Error('not parsed')
      expect(testCase.id).toBe(row.slug)
      expect(testCase.preconditions).toEqual({ app_state: 'fresh' })
      expect(testCase.steps[0]).toEqual({ id: 's1', action: 'launch' })
      // The snapshots came with the YAML, in the same commit.
      const files = await server.store.listFiles(
        huynh.tenantId,
        project.project.id,
        `snap/${row.slug}`,
        row.headCommit,
      )
      expect(files).toContain(`snap/${row.slug}/s1/screen.jpg`)
      // Every step's locators are found in the tree it was recorded on (SC-006).
      for (const step of testCase.steps.slice(1)) {
        expect(files).toContain(`snap/${row.slug}/${step.id}/tree.json`)
        const target = 'target' in step ? step.target : undefined
        const first = target?.find((l) => l.image === undefined)
        if (!first) continue
        const text = await server.store.readFile(
          huynh.tenantId,
          project.project.id,
          `snap/${row.slug}/${step.id}/tree.json`,
          row.headCommit,
        )
        const tree: ElementNode[] = elementTreeSchema.parse(JSON.parse(text ?? '[]'))
        const ctx = {
          platform: 'android' as const,
          screen: { width: 1080, height: 2400 },
          appId: SAMPLE_APP,
        }
        expect(findAll(first, tree, ctx).length, `${row.slug} ${step.id}`).toBeGreaterThan(0)
      }
    }
    // A flow opens a screen the exploration reached first: the fake writer's "open <screen>".
    expect(written.map((t) => t.slug)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^open-/)]),
    )
  })

  it('leaves out what the project already has when the app is explored again', async () => {
    const repo = explorationsRepo(server.db, huynh.tenantId)
    const again = await explore(
      {
        project: { id: first.projectId } as never,
        app: { id: first.appId } as never,
        build: { id: first.buildId } as never,
      },
      first.deviceId,
    )
    expect(again.status).toBe('done')
    expect(again.stats.tests_written).toBe(0)
    expect((await repo.get(first.id)).stats.tests_written).toBeGreaterThanOrEqual(3)
  })
})
