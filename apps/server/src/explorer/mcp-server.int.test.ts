import { FAKE_OTP, startOtpServer } from '@coral/brain/testing'
import { SAMPLE_OTP } from '@coral/runner/testing'
import { api, newId, validateTestCaseSource, type ActionDecision } from '@coral/shared'
import { and, asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { brainCalls, toolCalls } from '../db/schema'
import { explorationsRepo, type ExplorationRow } from '../repos/explorations'
import { projectsRepo } from '../repos/projects'
import { testCasesRepo } from '../repos/test-cases'
import type { DeviceAgent } from '../testing/device-agent'
import { startRunServer, type RunServer } from '../testing/run-server'
import { sampleDevice, sampleProject } from '../testing/sample-project'
import type { TestUser } from '../testing/test-server'

// US7 (T059, SC-003): the MCP servers of mcp.yaml in an exploration — the AI reads the code of the
// Verify Code screen with `get_otp` and gets past it; `send_sms` (a side effect not allowed) and
// `delete_user` (not in the file) are blocked before reaching the server, and all three are in
// `tool_calls`. The test case typing a tool's value is a draft for a person (`needs_human`).
const TOKEN = 'otp-token-0123456789'
const PHONE = '0909123456'
const GOAL =
  'Open the menu, then Verify Code: type the code sent by SMS, tap Verify, until "Code verified"'

let server: RunServer
let otp: Awaited<ReturnType<typeof startOtpServer>>
let huynh: TestUser
const agents: DeviceAgent[] = []

beforeAll(async () => {
  otp = await startOtpServer({ token: TOKEN })
  server = await startRunServer({
    secrets: { OTP_TOKEN: TOKEN, TEST_PHONE: PHONE },
    explorer: {
      validate: false,
      // On the Verify Code screen, before typing: the allowed tool and two the AI may not call.
      fakeScript: {
        tools: (task, round) =>
          task.kind === 'next_action' &&
          round === 1 &&
          task.input.screen.elements.some((e) => e.id === 'otpET' && e.flags.includes('new'))
            ? [
                { name: 'otp__get_otp', args: { phone: '${secret:TEST_PHONE}' } },
                { name: 'otp__send_sms', args: { phone: '${secret:TEST_PHONE}', text: 'hi' } },
                { name: 'otp__delete_user', args: { email: 'bod@example.com' } },
              ]
            : undefined,
      },
    },
  })
  huynh = await server.newUser('Huynh')
})
afterAll(async () => {
  for (const agent of agents) agent.close()
  await server.close()
  await otp.close()
})

const mcpYaml = (url: string) => `schema: coral/mcp@1
servers:
  otp:
    url: ${url}
    headers:
      Authorization: 'Bearer \${secret:OTP_TOKEN}'
    tools:
      get_otp: {}
      send_sms: {}
`

async function setMcp(projectId: string, yaml: string) {
  const file = api.mcpFileSchema.parse(
    (await server.call(huynh, { method: 'GET', url: `/projects/${projectId}/mcp` })).body,
  )
  const res = await server.call(huynh, {
    method: 'PUT',
    url: `/projects/${projectId}/mcp`,
    payload: { yaml, base_commit: file.head_commit },
  })
  if (res.status !== 200) throw new Error(`mcp.yaml not saved: ${JSON.stringify(res.body)}`)
}

async function explore(mcpUrl: string) {
  const project = await sampleProject(server, huynh)
  await setMcp(project.project.id, mcpYaml(mcpUrl))
  const { sample, deviceId } = await sampleDevice(server, huynh, `mcp-${newId().slice(-6)}`)
  agents.push(sample)
  const repo = explorationsRepo(server.db, huynh.tenantId)
  const started = await server.explorations.start(
    { tenantId: huynh.tenantId, userId: huynh.userId },
    {
      project_id: project.project.id,
      app_id: project.app.id,
      build_id: project.build.id,
      device_id: deviceId,
      goal: GOAL,
      budget: { max_steps: 12 },
    },
  )
  const deadline = Date.now() + 90_000
  let row: ExplorationRow
  for (;;) {
    row = await repo.get(started.id)
    if (['done', 'stopped', 'failed', 'interrupted'].includes(row.status)) break
    if (Date.now() > deadline) throw new Error(`exploration still ${row.status}`)
    await new Promise((r) => setTimeout(r, 100))
  }
  const steps = await repo.steps(started.id, { limit: 1000 })
  const tools = await server.db
    .select({
      server: toolCalls.mcpServer,
      tool: toolCalls.tool,
      args: toolCalls.argsRedacted,
      ok: toolCalls.ok,
      blocked: toolCalls.blocked,
      error: toolCalls.error,
    })
    .from(toolCalls)
    .innerJoin(brainCalls, eq(brainCalls.id, toolCalls.brainCallId))
    .where(and(eq(toolCalls.tenantId, huynh.tenantId), eq(brainCalls.refId, started.id)))
    .orderBy(asc(toolCalls.createdAt))
  const projects = projectsRepo(server.db, huynh.tenantId, server.store)
  const testCases = testCasesRepo(server.db, huynh.tenantId, server.store, projects)
  const written = await testCases.list(project.project.id, {
    sourceRef: `exploration:${started.id}`,
  })
  return { row, steps, tools, written, testCases }
}

describe('MCP tools in an exploration (US7, T059)', { timeout: 120_000 }, () => {
  it('reads the OTP with the allowed tool, blocks the others, drafts the test for a person', async () => {
    expect(FAKE_OTP).toBe(SAMPLE_OTP)
    const before = otp.calls.length
    const { row, steps, tools, written, testCases } = await explore(otp.url)
    expect(row).toMatchObject({ status: 'done', stopReason: 'goal_reached' })

    // SC-003: one call through, two blocked, all three logged; secrets only by name.
    expect(tools).toEqual([
      {
        server: 'otp',
        tool: 'get_otp',
        args: { phone: '${secret:TEST_PHONE}' },
        ok: true,
        blocked: false,
        error: null,
      },
      {
        server: 'otp',
        tool: 'send_sms',
        args: { phone: '${secret:TEST_PHONE}', text: 'hi' },
        ok: false,
        blocked: true,
        error: 'side_effects_disabled',
      },
      {
        server: 'otp',
        tool: 'delete_user',
        args: { email: 'bod@example.com' },
        ok: false,
        blocked: true,
        error: 'not_allowed',
      },
    ])
    // Only the allowed call reached the server, with the phone number itself.
    expect(otp.calls.slice(before)).toEqual([{ name: 'get_otp', args: { phone: PHONE } }])

    // The code was typed, flagged as a tool's value; the screen let the AI through.
    const typed = steps.find((s) => (s.decision as ActionDecision | null)?.action === 'type')
    expect(typed).toMatchObject({
      status: 'done',
      decision: { text: FAKE_OTP },
      flags: ['mcp_value'],
    })
    expect(steps.at(-1)?.decision).toMatchObject({ action: 'done', goal_reached: true })

    expect(written).toHaveLength(1)
    const testCase = written[0]
    if (!testCase) throw new Error('no test case')
    expect(testCase).toMatchObject({
      source: 'ai_prompt',
      status: 'draft',
      draftReason: 'needs_human',
    })
    const parsed = validateTestCaseSource(await testCases.readYaml(testCase), 'x.yaml').value
    expect(parsed?.steps.some((s) => s.action === 'type')).toBe(true)
  })

  it('offers no tool of a server it cannot reach: a person has to give the code', async () => {
    const { row, tools, written } = await explore('http://127.0.0.1:9/mcp')
    // The fake gives the goal up (an SMS code, nothing to read it with); no call is logged.
    expect(row).toMatchObject({ status: 'done', stopReason: 'goal_not_reached' })
    expect(tools).toEqual([])
    expect(written).toEqual([])
  })
})
