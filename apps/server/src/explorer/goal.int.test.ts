import { PLACE_ORDER } from '@coral/runner/testing'
import { validateTestCaseSource, type Step } from '@coral/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { explorationsRepo, type ExplorationRow } from '../repos/explorations'
import { projectsRepo } from '../repos/projects'
import { testCasesRepo } from '../repos/test-cases'
import type { DeviceAgent } from '../testing/device-agent'
import { startRunServer, type RunServer } from '../testing/run-server'
import { sampleDevice, sampleProject } from '../testing/sample-project'
import type { TestUser } from '../testing/test-server'

// US5 (T048): a test case from a goal — the Explorer stops once the AI says the goal is reached,
// the writer turns only the way there into one `ai_prompt` test case (validated like any other:
// e2e/us5-prompt.e2e.ts); a goal behind a never_tap button, or out of budget, ends
// `goal_not_reached` with no test case.
let server: RunServer
let huynh: TestUser
let deviceId = ''
const agents: DeviceAgent[] = []

beforeAll(async () => {
  // This device agent explores but runs no job: validation is left to the E2E.
  server = await startRunServer({ explorer: { validate: false } })
  huynh = await server.newUser('Huynh')
  const found = await sampleDevice(server, huynh, 'goal-1')
  agents.push(found.sample)
  deviceId = found.deviceId
})
afterAll(async () => {
  for (const agent of agents) agent.close()
  await server.close()
})

async function explore(goal: string, maxSteps = 30) {
  const project = await sampleProject(server, huynh)
  const repo = explorationsRepo(server.db, huynh.tenantId)
  const started = await server.explorations.start(
    { tenantId: huynh.tenantId, userId: huynh.userId },
    {
      project_id: project.project.id,
      app_id: project.app.id,
      build_id: project.build.id,
      device_id: deviceId,
      goal,
      budget: { max_steps: maxSteps },
    },
  )
  expect(started).toMatchObject({ kind: 'prompt', goal, max_tests: 1 })
  const deadline = Date.now() + 90_000
  let row: ExplorationRow
  for (;;) {
    row = await repo.get(started.id)
    if (['done', 'stopped', 'failed', 'interrupted'].includes(row.status)) break
    if (Date.now() > deadline) throw new Error(`exploration still ${row.status}`)
    await new Promise((r) => setTimeout(r, 100))
  }
  const steps = await repo.steps(started.id, { limit: 1000 })
  const projects = projectsRepo(server.db, huynh.tenantId, server.store)
  const testCases = testCasesRepo(server.db, huynh.tenantId, server.store, projects)
  const written = await testCases.list(project.project.id, {
    sourceRef: `exploration:${started.id}`,
  })
  return { row, steps, written, testCases }
}

describe('test case from a goal (US5, T048)', { timeout: 120_000 }, () => {
  it('reaches the goal and writes one validated test of the way there', async () => {
    const goal = 'Open the cart until "My Cart"'
    const { row, steps, written, testCases } = await explore(goal)
    expect(row).toMatchObject({ status: 'done', stopReason: 'goal_reached' })
    const last = steps.at(-1)
    expect(last?.decision).toMatchObject({ action: 'done', goal_reached: true })

    expect(written).toHaveLength(1)
    const testCase = written[0]
    if (!testCase) throw new Error('no test case')
    expect(testCase).toMatchObject({ source: 'ai_prompt', status: 'draft' })
    const parsed = validateTestCaseSource(await testCases.readYaml(testCase), 'x.yaml').value
    expect(parsed?.intent).toBe(goal)
    // Only the way to the goal: launch, tap the cart — and the goal on screen is expected.
    expect(parsed?.steps.map((s: Step) => s.action)).toEqual(['launch', 'tap'])
    expect(parsed?.steps[1]?.expect).toEqual(expect.arrayContaining([{ visible_text: 'My Cart' }]))
    expect(row.stats).toMatchObject({ tests_written: 1 })
    expect(row.writerReport).toEqual({ flows: 1, skipped: [], error: null })
  })

  it('does not tap a never_tap button the goal needs: goal_not_reached, no test case', async () => {
    const { row, steps, written } = await explore(
      `${PLACE_ORDER} for the cart until "Your order has been placed"`,
    )
    expect(row).toMatchObject({ status: 'done', stopReason: 'goal_not_reached' })
    // On the cart the AI is told Place Order is never to be tapped: it gives the goal up there.
    expect(steps.at(-1)?.decision).toMatchObject({
      action: 'done',
      goal_reached: false,
      reason: expect.stringContaining(`forbidden action: "${PLACE_ORDER}"`) as string,
    })
    for (const step of steps) expect(JSON.stringify(step.step)).not.toContain(PLACE_ORDER)
    expect(written).toEqual([])
    expect(row.writerReport).toBeNull()
  })

  it('ends goal_not_reached when the budget runs out first', async () => {
    const { row, steps, written } = await explore('Find the screen "Nowhere"', 4)
    expect(row).toMatchObject({ status: 'done', stopReason: 'goal_not_reached' })
    expect(steps).toHaveLength(4)
    expect(written).toEqual([])
  })
})
