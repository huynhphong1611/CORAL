import { api, newId } from '@coral/shared'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadKnowledge } from '../ai/knowledge'
import { auditLog } from '../db/schema'
import { startTestServer, type TestServer, type TestUser } from '../testing/test-server'

// US4 (T044): the project's knowledge through the API — AGENTS.md, skills with rules.yaml and
// mcp.yaml: one commit per save, a stale base refused, problems at their line, who may change
// what, another tenant's project not found.
let server: TestServer
let huynh: TestUser
let lan: TestUser
let mai: TestUser
let projectId = ''

beforeAll(async () => {
  server = await startTestServer({ mcpStdioAllowlist: ['playwright'] })
  huynh = await server.newUser('Huynh')
  lan = await server.teammate(huynh, 'Lan', 'member')
  mai = await server.teammate(huynh, 'Mai', 'viewer')
  projectId = api.projectSchema.parse(
    (await server.call(huynh, { method: 'POST', url: '/projects', payload: { name: 'Know' } }))
      .body,
  ).id
})
afterAll(() => server.close())

const SKILL = `---
name: login-demo-account
description: Log in to My Demo App with the demo account on the Login screen
---
Open the menu, then Log In. Username is secret TEST_USER, password TEST_PASSWORD.
`
const RULES = `schema: coral/skill-rules@1
never_tap: ['Place Order']
test_data:
  username: '\${secret:TEST_USER}'
  zip: '70000'
`

const get = (user: TestUser, path: string) =>
  server.call(user, { method: 'GET', url: `/projects/${projectId}${path}` })
const put = (user: TestUser, path: string, payload: object) =>
  server.call(user, { method: 'PUT', url: `/projects/${projectId}${path}`, payload })

describe('knowledge routes (US4, T044)', () => {
  it('edits AGENTS.md as commits, refusing a stale base but not an unrelated commit', async () => {
    const empty = api.agentsMdSchema.parse((await get(lan, '/agents-md')).body)
    expect(empty.content).toBe('')

    const saved = await put(lan, '/agents-md', {
      content: '# My Demo App\nWrite intents in English.\n',
      base_commit: empty.head_commit,
    })
    expect(saved.status).toBe(200)
    const head = api.knowledgeSavedSchema.parse(saved.body).head_commit
    expect(api.agentsMdSchema.parse((await get(mai, '/agents-md')).body)).toEqual({
      content: '# My Demo App\nWrite intents in English.\n',
      head_commit: head,
    })

    // Someone else saved it since: refused, like the test case editor.
    expect(
      (await put(huynh, '/agents-md', { content: 'other', base_commit: empty.head_commit })).body,
    ).toMatchObject({ error: { code: 'conflict' } })
    // A commit to another file (popups.yaml) does not make the base stale.
    const popups = api.popupsFileSchema.parse((await get(huynh, '/popups')).body)
    await put(huynh, '/popups', { yaml: popups.yaml, base_commit: popups.head_commit })
    expect((await put(huynh, '/agents-md', { content: 'v2\n', base_commit: head })).status).toBe(
      200,
    )

    expect((await put(mai, '/agents-md', { content: 'x', base_commit: head })).status).toBe(403)
    const big = 'x'.repeat(64 * 1024 + 1)
    expect((await put(huynh, '/agents-md', { content: big, base_commit: head })).status).toBe(400)
  })

  it('saves a skill with its rules, lists it, drops its rules, deletes it', async () => {
    const base = api.agentsMdSchema.parse((await get(lan, '/agents-md')).body).head_commit
    const wrongName = await put(lan, '/skills/login-demo-account', {
      skill_md: SKILL.replace('name: login-demo-account', 'name: other'),
      base_commit: base,
    })
    expect(wrongName.status).toBe(400)
    expect((wrongName.body as api.ApiError).error.details).toEqual([
      expect.objectContaining({ code: 'schema', line: 2 }),
    ])
    const badRules = await put(lan, '/skills/login-demo-account', {
      skill_md: SKILL,
      rules_yaml: RULES.replace('never_tap', 'never_click'),
      base_commit: base,
    })
    expect(badRules.status).toBe(400)
    expect(
      (await put(lan, '/skills/Bad_Name', { skill_md: SKILL, base_commit: base })).status,
    ).toBe(400)

    const saved = await put(lan, '/skills/login-demo-account', {
      skill_md: SKILL,
      rules_yaml: RULES,
      base_commit: base,
    })
    expect(saved.status).toBe(200)
    const head = api.knowledgeSavedSchema.parse(saved.body).head_commit
    expect(api.skillSummarySchema.array().parse((await get(mai, '/skills')).body)).toEqual([
      {
        name: 'login-demo-account',
        description: 'Log in to My Demo App with the demo account on the Login screen',
        has_rules: true,
      },
    ])
    expect(
      api.skillDetailSchema.parse((await get(mai, '/skills/login-demo-account')).body),
    ).toEqual({ name: 'login-demo-account', skill_md: SKILL, rules_yaml: RULES, head_commit: head })

    // What the Explorer reads: the skill listed, its rules merged, secrets only by name.
    const loaded = await loadKnowledge(server.store, huynh.tenantId, projectId, {
      stdioAllowlist: [],
    })
    expect(loaded.knowledge.skills.map((s) => s.name)).toEqual(['login-demo-account'])
    expect(loaded.rules.neverTap).toEqual(['Place Order'])
    expect(loaded.knowledge.testData).toEqual([
      { name: 'username', secret: 'TEST_USER' },
      { name: 'zip', value: '70000' },
    ])

    // Saved again without rules.yaml: it is gone.
    const noRules = await put(lan, '/skills/login-demo-account', {
      skill_md: SKILL,
      base_commit: head,
    })
    const head2 = api.knowledgeSavedSchema.parse(noRules.body).head_commit
    expect(
      api.skillDetailSchema.parse((await get(lan, '/skills/login-demo-account')).body).rules_yaml,
    ).toBeNull()

    const remove = (baseCommit: string) =>
      server.call(lan, {
        method: 'DELETE',
        url: `/projects/${projectId}/skills/login-demo-account?base_commit=${baseCommit}`,
      })
    expect((await remove(head)).body).toMatchObject({ error: { code: 'conflict' } })
    expect((await remove(head2)).status).toBe(204)
    expect((await get(lan, '/skills/login-demo-account')).status).toBe(404)
    expect((await get(lan, '/skills')).body).toEqual([])
    expect((await remove(head2)).status).toBe(404)
  })

  it('lets only owners and admins change mcp.yaml, within the stdio allowlist, audited', async () => {
    const file = api.mcpFileSchema.parse((await get(lan, '/mcp')).body)
    expect(file.yaml).toBe('')
    // Local (stdio) servers only under a name the platform allows.
    const yaml = (server: string) => `schema: coral/mcp@1
servers:
  otp:
    url: https://otp.test.example.com/mcp
    headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' }
    tools: { get_otp: {} }
  ${server}:
    command: playwright-mcp
    tools: { browser_snapshot: {} }
`
    expect(
      (await put(lan, '/mcp', { yaml: yaml('playwright'), base_commit: file.head_commit })).status,
    ).toBe(403)
    const refused = await put(huynh, '/mcp', {
      yaml: yaml('browser'),
      base_commit: file.head_commit,
    })
    expect(refused.status).toBe(400)
    expect((refused.body as api.ApiError).error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'stdio_not_allowed', line: 8 })]),
    )

    const saved = await put(huynh, '/mcp', {
      yaml: yaml('playwright'),
      base_commit: file.head_commit,
    })
    expect(saved.status).toBe(200)
    // A token written inline is saved but flagged.
    expect(saved.body).toMatchObject({
      warnings: [expect.objectContaining({ code: 'inline_credential' })],
    })
    expect(api.mcpFileSchema.parse((await get(mai, '/mcp')).body).yaml).toBe(yaml('playwright'))
    const audits = await server.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, huynh.tenantId), eq(auditLog.action, 'mcp.update')))
    expect(audits.map((a) => [a.actor, a.target])).toEqual([[`user:${huynh.userId}`, projectId]])
  })

  it("answers 404 for another tenant's project and an unknown project", async () => {
    const vy = await server.newUser('Vy')
    for (const path of ['/agents-md', '/skills', '/mcp']) {
      expect((await get(vy, path)).status).toBe(404)
    }
    expect(
      (
        await server.call(vy, {
          method: 'PUT',
          url: `/projects/${projectId}/agents-md`,
          payload: { content: 'x', base_commit: 'a'.repeat(40) },
        })
      ).status,
    ).toBe(404)
    expect(
      (await server.call(huynh, { method: 'GET', url: `/projects/${newId()}/agents-md` })).status,
    ).toBe(404)
  })
})
