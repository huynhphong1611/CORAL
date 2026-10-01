import { api } from '@coral/shared'
import { and, eq } from 'drizzle-orm'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrainsSettings } from '../ai/brains-config'
import { loadConfig } from '../config'
import { auditLog } from '../db/schema'
import { createRepos } from '../repos'
import { envSecrets } from '../runs/secrets'
import { startTestServer, type TestServer, type TestUser } from '../testing/test-server'

// US1 (T023): the tenant's brains config through the API — who may change it, how a broken one is
// refused (line and code), the fake providers only on a server that runs them, and the usage.
const FAKE_BRAINS = fileURLToPath(new URL('../../../../examples/brains.fake.yaml', import.meta.url))

let real: TestServer
let fake: TestServer
let huynh: TestUser
let lan: TestUser
let mai: TestUser

const settings = (fakeBrains: boolean) => {
  const ai = { ...loadConfig(process.env).ai }
  delete ai.brainsDefaultPath
  return new BrainsSettings({
    ai: { ...ai, fakeBrains, ...(fakeBrains ? { brainsDefaultPath: FAKE_BRAINS } : {}) },
    secrets: envSecrets({}),
  })
}

beforeAll(async () => {
  real = await startTestServer({ brains: settings(false) })
  fake = await startTestServer({ brains: settings(true) })
  huynh = await real.newUser('Huynh')
  lan = await real.teammate(huynh, 'Lan', 'member')
  mai = await real.teammate(huynh, 'Mai', 'viewer')
})
afterAll(async () => {
  await real.close()
  await fake.close()
})

const CLAUDE = `schema: coral/brains@1
# The explorer sees screens: a vision model.
roles:
  explorer: { provider: claude, model: claude-opus-5-5 }
  writer: { provider: gemini, model: gemini-pro-preview }
fallback: [gemini]
providers:
  gemini: { model: gemini-pro-preview }
prices:
  gemini-pro-preview: { input: 2, output: 12 }
limits:
  max_cost_usd_per_day: 15
`

const put = (server: TestServer, user: TestUser, body: string | object) =>
  server.call(user, {
    method: 'PUT',
    url: '/brains/config',
    ...(typeof body === 'string'
      ? { payload: body, headers: { 'content-type': 'application/yaml' } }
      : { payload: body }),
  })

describe('brains config routes (US1, T023)', () => {
  it('shows none, then the YAML an owner saved, comments kept, audited', async () => {
    const before = await real.call(huynh, { method: 'GET', url: '/brains/config' })
    expect(api.brainsConfigViewSchema.parse(before.body)).toMatchObject({
      source: 'none',
      yaml: '',
      config: null,
    })
    // The fake providers are not offered on a real server; Copilot is listed, off.
    expect(api.brainsConfigViewSchema.parse(before.body).providers).toEqual([
      { id: 'claude', enabled: true, vision: true },
      { id: 'gemini', enabled: true, vision: true },
      { id: 'copilot', enabled: false, vision: true },
    ])

    const saved = await put(real, huynh, CLAUDE)
    expect(saved.status).toBe(200)
    expect(api.brainsConfigViewSchema.parse(saved.body)).toMatchObject({
      source: 'tenant',
      yaml: CLAUDE,
      config: { roles: { explorer: { provider: 'claude' } }, limits: { max_cost_usd_per_day: 15 } },
    })
    const yaml = await real.call(huynh, {
      method: 'GET',
      url: '/brains/config',
      headers: { accept: 'application/yaml' },
    })
    expect(yaml.res.headers['content-type']).toMatch(/^application\/yaml/)
    expect(yaml.res.body).toBe(CLAUDE)

    const audits = await real.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenantId, huynh.tenantId), eq(auditLog.action, 'brains.config.update')),
      )
    expect(audits.map((a) => a.actor)).toEqual([`user:${huynh.userId}`])
  })

  it('takes JSON too, and refuses members and viewers', async () => {
    const json = {
      schema: 'coral/brains@1',
      roles: { explorer: { provider: 'gemini', model: 'gemini-pro-preview' } },
      prices: { 'gemini-pro-preview': { input: 2, output: 12 } },
    }
    expect((await put(real, lan, json)).status).toBe(403)
    expect((await put(real, mai, CLAUDE)).body).toMatchObject({ error: { code: 'forbidden' } })
    // Both may read it.
    expect((await real.call(mai, { method: 'GET', url: '/brains/config' })).status).toBe(200)

    const saved = await put(real, huynh, json)
    expect(saved.status).toBe(200)
    const view = api.brainsConfigViewSchema.parse(saved.body)
    expect(view.config?.roles.explorer).toEqual({ provider: 'gemini', model: 'gemini-pro-preview' })
    expect(view.yaml).toContain('provider: gemini')
  })

  it('refuses a broken config with the line and code of each problem', async () => {
    const broken = CLAUDE.replace(
      'gemini-pro-preview: { input: 2, output: 12 }',
      'other: { input: 1, output: 1 }',
    )
    const res = await put(real, huynh, broken)
    expect(res.status).toBe(400)
    const body = res.body as api.ApiError
    expect(body.error.code).toBe('validation_failed')
    const lines = broken.split('\n')
    const writerLine = lines.findIndex((l) => l.includes('writer:')) + 1
    expect(body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'price_missing', line: writerLine }),
      ]),
    )
    // Nothing was saved: still the JSON config of the test before.
    const current = await real.call(huynh, { method: 'GET', url: '/brains/config' })
    expect(api.brainsConfigViewSchema.parse(current.body).config?.roles.explorer.provider).toBe(
      'gemini',
    )
    expect((await put(real, huynh, '')).status).toBe(400)
  })

  it('accepts the fake providers only on a server that runs them (CORAL_BRAIN_FAKE)', async () => {
    const yaml = 'schema: coral/brains@1\nroles: { explorer: { provider: fake, model: fake } }\n'
    const refused = await put(real, huynh, yaml)
    expect(refused.status).toBe(400)
    expect((refused.body as api.ApiError).error.details).toEqual([
      expect.objectContaining({ code: 'provider_disabled', line: 2 }),
    ])

    const khoa = await fake.newUser('Khoa')
    // Its platform default is the fake config until the tenant saves its own.
    const before = await fake.call(khoa, { method: 'GET', url: '/brains/config' })
    expect(api.brainsConfigViewSchema.parse(before.body).source).toBe('platform')
    expect((await put(fake, khoa, yaml)).status).toBe(200)
  })

  it('sums the AI cost by day, role or provider, against the daily limit', async () => {
    const tran = await real.newUser('Tran')
    const other = await real.newUser('Vy')
    await put(real, tran, CLAUDE)
    const repos = createRepos({ db: real.db, store: real.store })
    const record = (tenantId: string, over: object) =>
      repos.tenant(tenantId).brainCalls.record({
        role: 'explorer',
        provider: 'claude',
        model: 'claude-opus-5-5',
        attempt: 1,
        tokensIn: 1000,
        tokensOut: 100,
        tokensCached: 0,
        costUsd: 0.5,
        latencyMs: 10,
        ok: true,
        refType: 'exploration',
        refId: tenantId,
        ...over,
      })
    await record(tran.tenantId, {})
    await record(tran.tenantId, { role: 'writer', provider: 'gemini', model: 'g', costUsd: 0.25 })
    await record(tran.tenantId, {
      createdAt: new Date(Date.now() - 2 * 86_400_000),
      costUsd: 1,
    })
    // Another tenant's calls never count.
    const mine = await record(other.tenantId, { costUsd: 9 })

    const usage = async (query: string) =>
      api.usageSchema.parse(
        (await real.call(tran, { method: 'GET', url: `/usage/ai${query}` })).body,
      )
    const today = new Date().toISOString().slice(0, 10)

    const byProvider = await usage('?group=provider')
    expect(byProvider.rows).toEqual([
      { key: 'claude', calls: 2, tokens_in: 2000, tokens_out: 200, cost_usd: 1.5 },
      { key: 'gemini', calls: 1, tokens_in: 1000, tokens_out: 100, cost_usd: 0.25 },
    ])
    expect(byProvider.total_cost_usd).toBeCloseTo(1.75)
    expect(byProvider.today).toEqual({ cost_usd: 0.75, limit_usd: 15 })

    expect((await usage(`?group=role&from=${today}`)).rows).toEqual([
      expect.objectContaining({ key: 'explorer', calls: 1, cost_usd: 0.5 }),
      expect.objectContaining({ key: 'writer', calls: 1, cost_usd: 0.25 }),
    ])
    expect((await usage('?group=day')).rows.map((r) => r.calls)).toEqual([1, 2])
    expect(
      (await real.call(tran, { method: 'GET', url: '/usage/ai?from=2026-10-02&to=2026-10-01' }))
        .status,
    ).toBe(400)
    // Another tenant's call is not found.
    expect((await real.call(tran, { method: 'GET', url: `/brain-calls/${mine.id}` })).status).toBe(
      404,
    )
  })
})
