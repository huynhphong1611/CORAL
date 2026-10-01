import { GetObjectTaggingCommand, S3Client } from '@aws-sdk/client-s3'
import { EMPTY_KNOWLEDGE, type ScreenInput } from '@coral/brain'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ServerConfig } from '../config'
import { brainCalls } from '../db/schema'
import { createRepos, type Repos } from '../repos'
import { envSecrets } from '../runs/secrets'
import { RUN_ARTIFACT_TAG } from '../storage/s3'
import { startTestServer, type TestServer, type TestUser } from '../testing/test-server'
import { BrainsSettings } from './brains-config'
import { loadKnowledge } from './knowledge'
import { AiService } from './service'

const FAKE_BRAINS = fileURLToPath(new URL('../../../../examples/brains.fake.yaml', import.meta.url))
const SECRET = 'bod@example.com'
const env = { CORAL_SECRET_TEST_USER: SECRET, CORAL_SECRET_TEST_PASSWORD: '10203040' }
const author = { name: 'Huynh', email: 'huynh@coral.test' }

let server: TestServer
let repos: Repos
let huynh: TestUser

beforeAll(async () => {
  server = await startTestServer()
  repos = createRepos({ db: server.db, store: server.store })
  huynh = await server.newUser('Huynh')
})
afterAll(() => server.close())

const ai = (over: Partial<ServerConfig['ai']> = {}): ServerConfig['ai'] => ({
  ...server.config.ai,
  fakeBrains: true,
  brainsDefaultPath: FAKE_BRAINS,
  ...over,
})

function service(over: Partial<ServerConfig['ai']> = {}) {
  const config = ai(over)
  const secrets = envSecrets(env)
  const settings = new BrainsSettings({ ai: config, secrets })
  return {
    settings,
    service: new AiService({
      repos,
      store: server.store,
      artifacts: server.artifacts,
      settings,
      secrets,
      fakeBrains: config.fakeBrains,
      stdioAllowlist: [],
    }),
  }
}

async function newProject(name: string) {
  return repos.tenant(huynh.tenantId).projects.create(`${name}-${Date.now()}`, author)
}

const screen: ScreenInput = {
  width: 1080,
  height: 2400,
  appPackage: 'com.saucelabs.mydemoapp.android',
  elements: [
    { n: 1, className: 'EditText', text: SECRET, bounds: [0, 0, 900, 120], flags: ['new'] },
  ],
  visibleTexts: [{ text: `Signed in as ${SECRET}`, height: 90 }],
}

describe('brains config source (contracts/brains-yaml.md)', () => {
  it('uses the tenant config, else the platform default, else none', async () => {
    const tenantRepos = repos.tenant((await server.newUser('Lan')).tenantId)
    expect(
      (await service({ brainsDefaultPath: undefined }).settings.resolve(tenantRepos)).source,
    ).toBe('none')
    const { settings } = service()
    expect(await settings.resolve(tenantRepos)).toMatchObject({
      source: 'platform',
      config: { roles: { explorer: { provider: 'fake' } } },
    })
    const yaml =
      'schema: coral/brains@1\nroles: { explorer: { provider: fake-alt, model: fake } }\n'
    const checked = settings.validate(yaml)
    expect(checked.errors).toEqual([])
    await tenantRepos.settings.setBrains({
      yaml,
      config: checked.value!,
      updated_at: new Date().toISOString(),
      updated_by: huynh.userId,
    })
    expect(await settings.resolve(tenantRepos)).toMatchObject({
      source: 'tenant',
      yaml,
      config: { roles: { explorer: { provider: 'fake-alt' } } },
    })
  })

  it('refuses the fake providers without CORAL_BRAIN_FAKE', () => {
    const { settings } = service({ fakeBrains: false })
    const yaml = 'schema: coral/brains@1\nroles: { explorer: { provider: fake, model: fake } }\n'
    expect(settings.validate(yaml).errors.map((e) => [e.code, e.line])).toEqual([
      ['provider_disabled', 2],
    ])
    expect(() => settings.platformDefault()).toThrow(/CORAL_BRAINS_DEFAULT .* provider_disabled/)
    expect(settings.providerList().map((p) => p.id)).toEqual(['claude', 'gemini', 'copilot'])
    expect(
      service()
        .settings.providerList()
        .map((p) => p.id),
    ).toContain('fake-alt')
  })

  it('needs a price for every model, from the tenant or the platform table', () => {
    const { settings } = service()
    const yaml =
      'schema: coral/brains@1\nroles: { explorer: { provider: claude, model: unknown-model } }\n'
    expect(settings.validate(yaml).errors.map((e) => e.code)).toEqual(['price_missing'])
    expect(settings.priceTable()['claude-opus-5-5']).toMatchObject({ input: 4, output: 20 })
  })

  it('answers 409 brains_not_configured with neither config', async () => {
    const lan = await server.newUser('Mai')
    const project = await repos.tenant(lan.tenantId).projects.create(`p-${Date.now()}`, author)
    await expect(
      service({ brainsDefaultPath: undefined }).service.projectBrain({
        tenantId: lan.tenantId,
        projectId: project.id,
        ref: { type: 'exploration', id: project.id },
        maxCostUsd: 3,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'brains_not_configured' })
  })
})

describe('AI call records (FR-006, FR-006a, FR-013)', () => {
  it('stores each call with its cost, and its content tagged for 30 days without secret values', async () => {
    const { service: ai } = service()
    const tenant = (await server.newUser('Khoa')).tenantId
    const own = await repos.tenant(tenant).projects.create(`p-${Date.now()}`, author)
    const projectBrain = await ai.projectBrain({
      tenantId: tenant,
      projectId: own.id,
      ref: { type: 'exploration', id: own.id },
      maxCostUsd: 3,
    })
    const summary = await projectBrain.brain.describeScreen(
      screen,
      projectBrain.context('explorer'),
    )
    expect(summary.name).toContain('Signed in as')

    const [row] = await server.db.select().from(brainCalls).where(eq(brainCalls.refId, own.id))
    const key = row?.contentKey ?? ''
    expect(row).toMatchObject({
      role: 'explorer',
      provider: 'fake',
      model: 'fake',
      attempt: 1,
      ok: true,
    })
    expect(row?.costUsd).toBeGreaterThan(0)
    expect(projectBrain.lastCallId()).toBe(row?.id)
    expect(row?.contentKey).toBe(`${tenant}/ai/exploration/${own.id}/${row?.id}.json`)

    const bytes = await server.artifacts.getBytes(key)
    const text = new TextDecoder().decode(bytes)
    expect(text).not.toContain(SECRET)
    expect(text).toContain('${secret:TEST_USER}')
    const content = await ai.content.get(key)
    expect(content).toMatchObject({ provider: 'fake', attempt: 1, validation_errors: [] })

    const { s3 } = server.config
    const admin = new S3Client({
      endpoint: s3.endpoint,
      region: s3.region,
      forcePathStyle: true,
      credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
    })
    const tags = await admin.send(new GetObjectTaggingCommand({ Bucket: s3.bucket, Key: key }))
    expect(tags.TagSet).toEqual([{ Key: RUN_ARTIFACT_TAG.key, Value: RUN_ARTIFACT_TAG.value }])
    expect(await ai.content.get(`${tenant}/ai/exploration/${own.id}/missing.json`)).toBeNull()
  })

  it('refuses a call once the activity budget is spent, and counts the day', async () => {
    const tenant = (await server.newUser('Tuan')).tenantId
    const project = await repos.tenant(tenant).projects.create(`p-${Date.now()}`, author)
    const { service: ai } = service()
    const projectBrain = await ai.projectBrain({
      tenantId: tenant,
      projectId: project.id,
      ref: { type: 'exploration', id: project.id },
      maxCostUsd: 0.000001,
    })
    const ctx = projectBrain.context('explorer')
    await projectBrain.brain.describeScreen(screen, ctx)
    await expect(projectBrain.brain.describeScreen(screen, ctx)).rejects.toMatchObject({
      name: 'BudgetExceededError',
      scope: 'activity',
    })
    expect(await repos.tenant(tenant).brainCalls.costOfDay()).toBeGreaterThan(0)
  })
})

describe('project knowledge (FR-012)', () => {
  it('reads AGENTS.md, skills, merged rules and mcp.yaml of that project only', async () => {
    const a = await newProject('a')
    const b = await newProject('b')
    await server.store.commitFiles(huynh.tenantId, a.id, {
      files: {
        'AGENTS.md': `# Shop\n${'x'.repeat(20_000)}`,
        'skills/login-demo-account/SKILL.md':
          '---\nname: login-demo-account\ndescription: Log in with the demo account\n---\nUse TEST_USER.\n',
        'skills/login-demo-account/rules.yaml':
          "schema: coral/skill-rules@1\nnever_tap: ['Place Order']\ntest_data:\n  username: '${secret:TEST_USER}'\n  zip: '70000'\n",
        'skills/broken/SKILL.md': 'no frontmatter',
        'mcp.yaml':
          'schema: coral/mcp@1\nservers:\n  otp:\n    url: http://localhost:8765/mcp\n    tools: { get_otp: {} }\n',
      },
      author,
      message: 'knowledge',
    })
    const loadedA = await loadKnowledge(server.store, huynh.tenantId, a.id, { stdioAllowlist: [] })
    expect(loadedA.knowledge.agentsMd.length).toBe(16 * 1024)
    expect(loadedA.knowledge.skills).toEqual([
      { name: 'login-demo-account', description: 'Log in with the demo account' },
    ])
    expect(loadedA.skillBodies.get('login-demo-account')).toContain('Use TEST_USER.')
    expect(loadedA.knowledge.testData).toEqual([
      { name: 'username', secret: 'TEST_USER' },
      { name: 'zip', value: '70000' },
    ])
    expect(loadedA.rules.neverTap).toEqual(['Place Order'])
    expect(loadedA.mcp?.servers.otp?.url).toBe('http://localhost:8765/mcp')
    expect(loadedA.problems).toEqual([expect.stringContaining('skills/broken/SKILL.md')])
    // The prompt carries the secret's name, never its value.
    expect(JSON.stringify(loadedA.knowledge)).not.toContain(SECRET)

    // The AI of project A reads A's skill with read_skill; project B offers no such tool.
    const { service: ai } = service()
    const brainA = await ai.projectBrain({
      tenantId: huynh.tenantId,
      projectId: a.id,
      ref: { type: 'exploration', id: a.id },
      maxCostUsd: 3,
    })
    const toolsA = brainA.context('explorer').tools
    expect(toolsA.specs.map((t) => t.name)).toEqual(['read_skill'])
    expect((await toolsA.call('read_skill', { name: 'login-demo-account' })).result).toContain(
      'Use TEST_USER.',
    )
    const brainB = await ai.projectBrain({
      tenantId: huynh.tenantId,
      projectId: b.id,
      ref: { type: 'exploration', id: b.id },
      maxCostUsd: 3,
    })
    expect(brainB.context('explorer').tools.specs).toEqual([])
    expect(
      await brainB.context('explorer').tools.call('read_skill', { name: 'login-demo-account' }),
    ).toMatchObject({
      blocked: true,
    })

    const loadedB = await loadKnowledge(server.store, huynh.tenantId, b.id, { stdioAllowlist: [] })
    expect(loadedB.knowledge).toEqual(EMPTY_KNOWLEDGE)
    expect(loadedB.mcp).toBeNull()
  })
})
