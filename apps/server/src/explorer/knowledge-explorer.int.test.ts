import { DESCRIBE_ROLE, EXPLORER_ROLE, stableSystem } from '@coral/brain'
import { api, newId, sha256Hex, type Step } from '@coral/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadKnowledge } from '../ai/knowledge'
import { brainCalls } from '../db/schema'
import { explorationsRepo } from '../repos/explorations'
import type { DeviceAgent } from '../testing/device-agent'
import { startRunServer, type RunServer } from '../testing/run-server'
import { sampleDevice, sampleProject } from '../testing/sample-project'
import type { TestUser } from '../testing/test-server'

// US4 (T045): the project's knowledge drives the Explorer — a login skill's test data is typed
// by name, its secret values never reach the AI nor the trace, and another project's skills are
// not in the context (FR-012, FR-013, SC-008).
const USER = 'bod@example.com'
const PASSWORD = '10203040'
let server: RunServer
let huynh: TestUser
const agents: DeviceAgent[] = []

beforeAll(async () => {
  server = await startRunServer({
    explorer: { write: false },
    secrets: { TEST_USER: USER, TEST_PASSWORD: PASSWORD },
  })
  huynh = await server.newUser('Huynh')
})
afterAll(async () => {
  for (const agent of agents) agent.close()
  await server.close()
})

const LOGIN_SKILL = `---
name: login-demo-account
description: Log in with the demo account on the Login screen
---
Open the menu, then Log In. Type the username and password test data.
`
const LOGIN_RULES = `schema: coral/skill-rules@1
test_data:
  username: '\${secret:TEST_USER}'
  password: '\${secret:TEST_PASSWORD}'
`

async function addSkill(projectId: string, name: string, skillMd: string, rulesYaml?: string) {
  const base = api.agentsMdSchema.parse(
    (await server.call(huynh, { method: 'GET', url: `/projects/${projectId}/agents-md` })).body,
  ).head_commit
  const res = await server.call(huynh, {
    method: 'PUT',
    url: `/projects/${projectId}/skills/${name}`,
    payload: {
      skill_md: skillMd,
      ...(rulesYaml ? { rules_yaml: rulesYaml } : {}),
      base_commit: base,
    },
  })
  if (res.status !== 200) throw new Error(`skill not saved: ${JSON.stringify(res.body)}`)
}

describe('knowledge in the Explorer (US4, T045)', { timeout: 120_000 }, () => {
  it('types skill test data by name, never sending secret values, nor other projects', async () => {
    const mine = await sampleProject(server, huynh)
    const other = await sampleProject(server, huynh)
    await addSkill(mine.project.id, 'login-demo-account', LOGIN_SKILL, LOGIN_RULES)
    await addSkill(
      other.project.id,
      'zebra-checkout',
      '---\nname: zebra-checkout\ndescription: ZEBRA-ONLY-IN-THE-OTHER-PROJECT\n---\nBody\n',
    )
    const { sample, deviceId } = await sampleDevice(server, huynh, `know-${newId().slice(-6)}`)
    agents.push(sample)

    const started = await server.explorations.start(
      { tenantId: huynh.tenantId, userId: huynh.userId },
      {
        project_id: mine.project.id,
        app_id: mine.app.id,
        build_id: mine.build.id,
        device_id: deviceId,
        budget: { max_steps: 30 },
      },
    )
    const repo = explorationsRepo(server.db, huynh.tenantId)
    const deadline = Date.now() + 90_000
    for (;;) {
      const row = await repo.get(started.id)
      if (!['queued', 'running', 'writing', 'validating'].includes(row.status)) break
      if (Date.now() > deadline) throw new Error(`exploration still ${row.status}`)
      await new Promise((r) => setTimeout(r, 100))
    }

    // The username was typed from the skill's test data: the trace says which secret, not what.
    const steps = await repo.steps(started.id, { limit: 1000 })
    const typed = steps
      .map((row) => row.step as Step | null)
      .filter((step): step is Extract<Step, { action: 'type' }> => step?.action === 'type')
    expect(typed.map((step) => step.value)).toEqual(
      expect.arrayContaining(['${secret:TEST_USER}', '${secret:TEST_PASSWORD}']),
    )
    expect(JSON.stringify(steps)).not.toContain(USER)
    expect(JSON.stringify(steps)).not.toContain(PASSWORD)

    // What the AI was sent: the skill by name, secrets by name, nothing of the other project.
    const calls = await server.db.select().from(brainCalls).where(eq(brainCalls.refId, started.id))
    expect(calls.length).toBeGreaterThan(0)
    const contents = await Promise.all(
      calls.map(async (call) =>
        call.contentKey
          ? new TextDecoder().decode(await server.artifacts.getBytes(call.contentKey))
          : '',
      ),
    )
    const all = contents.join('\n')
    expect(all).not.toContain(USER)
    expect(all).not.toContain(PASSWORD)

    // The system prompt (stored as its hash) is the one built from this project's knowledge:
    // the login skill and its test data by name, nothing of the other project.
    const loaded = await loadKnowledge(server.store, huynh.tenantId, mine.project.id, {
      stdioAllowlist: [],
    })
    const prompts = [DESCRIBE_ROLE, EXPLORER_ROLE].map((role) =>
      stableSystem(role, loaded.knowledge),
    )
    for (const prompt of prompts) {
      expect(prompt).toContain('login-demo-account')
      expect(prompt).toContain('secret TEST_USER')
      expect(prompt).not.toContain(USER)
      expect(prompt).not.toContain('zebra')
    }
    const hashes = new Set(prompts.map(sha256Hex))
    for (const content of contents.filter(Boolean)) {
      const stored = api.brainCallContentSchema.parse(JSON.parse(content))
      expect(hashes.has(stored.system.stable_hash), stored.role).toBe(true)
    }
  })
})
