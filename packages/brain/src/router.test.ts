import { brainsSchema, sha256Hex, type ModelPrice } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import {
  BrainUnavailableError,
  BudgetExceededError,
  EMPTY_KNOWLEDGE,
  NO_TOOLS,
  ProviderError,
  type CallContext,
  type ProviderAdapter,
  type ScreenInput,
} from './brain'
import { candidatesFor, costOf, createBrain, type CallRecord, type RouterDeps } from './router'
import { final, scriptedAdapter } from './testing/scripted'

const config = brainsSchema.parse({
  schema: 'coral/brains@1',
  roles: { explorer: { provider: 'gemini', model: 'flash' } },
  fallback: ['gemini', 'claude'],
  providers: { claude: { model: 'opus' } },
  limits: { max_cost_usd_per_day: 5 },
})
const prices: Record<string, ModelPrice> = {
  flash: { input: 0.3, output: 2.5, cached_input: 0.075 },
  opus: { input: 4, output: 20, cached_input: 0.2 },
}
const screen: ScreenInput = {
  width: 1080,
  height: 2400,
  appPackage: 'com.example.shop',
  elements: [
    { n: 1, className: 'Button', text: 'Log In', bounds: [0, 0, 100, 50], flags: ['new'] },
  ],
  visibleTexts: [{ text: 'Products', height: 80 }],
  image: { mediaType: 'image/jpeg', data: 'QUJD', ref: 't/explorations/e/3/ai.jpg' },
}
const summary = { name: 'Products', purpose: 'List of products' }

function setup(
  adapters: Partial<Record<string, ProviderAdapter>>,
  over: Partial<RouterDeps> & { spent?: number } = {},
) {
  const records: CallRecord[] = []
  const brain = createBrain({
    config,
    adapters,
    price: (model) => prices[model],
    dailySpentUsd: () => Promise.resolve(0),
    record: (call) => {
      records.push(call)
      return Promise.resolve()
    },
    ...over,
  })
  const ctx: CallContext = {
    tenantId: 't1',
    role: 'explorer',
    ref: { type: 'exploration', id: 'e1' },
    budget: { maxCostUsd: 3, spentUsd: () => Promise.resolve(over.spent ?? 0) },
    knowledge: EMPTY_KNOWLEDGE,
    tools: NO_TOOLS,
  }
  return { brain, records, ctx }
}

describe('router (research R4)', () => {
  it('falls back to the next provider on a 429 and records both attempts', async () => {
    const gemini = scriptedAdapter([new ProviderError('rate_limited', '429')], 'gemini')
    const claude = scriptedAdapter([final(summary)], 'claude')
    const { brain, records, ctx } = setup({ gemini, claude })
    expect(await brain.describeScreen(screen, ctx)).toEqual(summary)
    expect(records.map((r) => [r.attempt, r.provider, r.model, r.ok, r.error])).toEqual([
      [1, 'gemini', 'flash', false, 'rate_limited'],
      [2, 'claude', 'opus', true, undefined],
    ])
    expect(claude.requests[0]?.model).toBe('opus')
  })

  it('does not fall back on a bad request', async () => {
    const gemini = scriptedAdapter([new ProviderError('bad_request', '400')], 'gemini')
    const claude = scriptedAdapter([final(summary)], 'claude')
    const { brain, records, ctx } = setup({ gemini, claude })
    await expect(brain.describeScreen(screen, ctx)).rejects.toMatchObject({ kind: 'bad_request' })
    expect(claude.requests).toHaveLength(0)
    expect(records).toMatchObject([{ provider: 'gemini', error: 'provider_error' }])
  })

  it('falls back after three invalid answers', async () => {
    const gemini = scriptedAdapter([final('{"oops":1}')], 'gemini')
    const claude = scriptedAdapter([final(summary)], 'claude')
    const { brain, records, ctx } = setup({ gemini, claude })
    expect(await brain.describeScreen(screen, ctx)).toEqual(summary)
    expect(records.map((r) => [r.attempt, r.provider, r.error])).toEqual([
      [1, 'gemini', 'invalid_output'],
      [2, 'gemini', 'invalid_output'],
      [3, 'gemini', 'invalid_output'],
      [4, 'claude', undefined],
    ])
  })

  it('blocks a call before it is made once the daily limit or the budget is spent', async () => {
    const gemini = scriptedAdapter([final(summary)], 'gemini')
    const daily = setup({ gemini }, { dailySpentUsd: () => Promise.resolve(5) })
    await expect(daily.brain.describeScreen(screen, daily.ctx)).rejects.toMatchObject({
      name: 'BudgetExceededError',
      scope: 'daily',
    })
    const budget = setup({ gemini }, { spent: 3 })
    const failure = budget.brain.describeScreen(screen, budget.ctx)
    await expect(failure).rejects.toBeInstanceOf(BudgetExceededError)
    await expect(failure).rejects.toMatchObject({ scope: 'activity' })
    expect(gemini.requests).toHaveLength(0)
    expect([...daily.records, ...budget.records]).toEqual([])
  })

  it('prices tokens per million, cached input at its own rate', () => {
    // 1000 × 4 + 4000 × 0.2 + 200 × 20 per million.
    expect(costOf({ input: 1000, output: 200, cachedInput: 4000 }, prices.opus!)).toBeCloseTo(
      0.0088,
      10,
    )
    expect(
      costOf({ input: 1000, output: 0, cachedInput: 1000 }, { input: 1, output: 1 }),
    ).toBeCloseTo(0.002, 10)
  })

  it('records the cost of each attempt, cached tokens included', async () => {
    const gemini = scriptedAdapter(
      [{ ...final(summary), usage: { input: 2000, output: 100, cachedInput: 8000 } }],
      'gemini',
    )
    const { brain, records, ctx } = setup({ gemini })
    await brain.describeScreen(screen, ctx)
    // 2000 × 0.30 + 8000 × 0.075 + 100 × 2.50 per million.
    expect(records[0]?.costUsd).toBeCloseTo(0.00145, 10)
  })

  it('routes the writer to the explorer when it has no role of its own', async () => {
    expect(candidatesFor(config, 'writer').map((c) => c.provider)).toEqual(['gemini', 'claude'])
    const writerConfig = brainsSchema.parse({
      ...config,
      roles: { ...config.roles, writer: { provider: 'claude', model: 'opus', effort: 'medium' } },
    })
    expect(candidatesFor(writerConfig, 'writer')).toEqual([
      { provider: 'claude', model: 'opus', effort: 'medium' },
      { provider: 'gemini', model: 'flash' },
    ])
  })

  it('skips a provider whose model has no price, and fails when none is left', async () => {
    const gemini = scriptedAdapter([final(summary)], 'gemini')
    const claude = scriptedAdapter([final(summary)], 'claude')
    const { brain, ctx, records } = setup(
      { gemini, claude },
      { price: (model) => (model === 'opus' ? prices.opus : undefined) },
    )
    expect(await brain.describeScreen(screen, ctx)).toEqual(summary)
    expect(gemini.requests).toHaveLength(0)
    expect(records.map((r) => r.provider)).toEqual(['claude'])
    const none = setup({ gemini }, { price: () => undefined })
    await expect(none.brain.describeScreen(screen, none.ctx)).rejects.toBeInstanceOf(
      BrainUnavailableError,
    )
  })

  it('stores the content with a hash of the stable prompt and the image key, not its bytes', async () => {
    const gemini = scriptedAdapter([final(summary)], 'gemini')
    const { brain, records, ctx } = setup({ gemini })
    await brain.describeScreen(screen, ctx)
    const content = records[0]?.content
    expect(content?.system.stable_hash).toBe(sha256Hex(gemini.requests[0]?.system.stable ?? ''))
    expect(content?.messages[0]).toMatchObject({ role: 'user', image: 't/explorations/e/3/ai.jpg' })
    expect(JSON.stringify(content)).not.toContain('QUJD')
    expect(content?.decision).toEqual(summary)
  })
})
