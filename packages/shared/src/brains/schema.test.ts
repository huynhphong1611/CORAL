import { describe, expect, it } from 'vitest'
import { examples } from '../testing/fixtures'
import {
  DEFAULT_LIMITS,
  DEFAULT_PROVIDER_CAPABILITIES,
  fallbackModel,
  roleOf,
  validateBrainsSource,
  type BrainsCheckOptions,
} from './schema'

const example = examples['brains.example.yaml'] ?? ''
const prices: BrainsCheckOptions['platformHasPrice'] = (model) =>
  ['claude-opus-5-5', 'gemini-flash'].includes(model)

const codes = (source: string, options: BrainsCheckOptions = {}) =>
  validateBrainsSource(source, 'brains.yaml', options).errors.map((e) => [e.code, e.line])

describe('validateBrainsSource', () => {
  const valid = `schema: coral/brains@1
roles:
  explorer: { provider: gemini, model: gemini-flash }
  writer: { provider: claude, model: claude-opus-5-5, effort: medium }
fallback: [claude]
limits:
  max_cost_usd_per_day: 20
providers: { claude: { model: claude-opus-5-5 } }
`

  it('accepts a valid configuration and fills the defaults', () => {
    const result = validateBrainsSource(valid, 'brains.yaml', { platformHasPrice: prices })
    expect(result.errors).toEqual([])
    expect(result.value?.limits).toEqual({ ...DEFAULT_LIMITS, max_cost_usd_per_day: 20 })
    expect(roleOf(result.value!, 'writer')).toEqual({
      provider: 'claude',
      model: 'claude-opus-5-5',
      effort: 'medium',
    })
    expect(fallbackModel(result.value!, 'claude')).toBe('claude-opus-5-5')
  })

  it('lets writer fall back to explorer and models come from providers', () => {
    const result = validateBrainsSource(
      `schema: coral/brains@1
roles: { explorer: { provider: gemini } }
providers: { gemini: { model: gemini-flash, api_key_secret: GEMINI_KEY } }
`,
    )
    expect(result.errors).toEqual([])
    expect(roleOf(result.value!, 'writer')).toEqual({ provider: 'gemini', model: 'gemini-flash' })
  })

  it('reports each problem on its line', () => {
    expect(codes(valid.replace('provider: gemini', 'provider: gpt'))).toEqual([
      ['unknown_provider', 3],
    ])
    expect(codes(valid.replace('provider: claude,', 'provider: copilot,'))).toEqual([
      ['provider_disabled', 4],
    ])
    expect(codes(valid, { platformHasPrice: () => false })).toEqual([
      ['price_missing', 3],
      ['price_missing', 4],
      ['price_missing', 5],
    ])
    // A fallback provider needs a model of its own when no role names one for it.
    expect(codes(valid.replace('providers: { claude: { model: claude-opus-5-5 } }', ''))).toEqual(
      [],
    )
    expect(
      codes(
        valid
          .replace('providers: { claude: { model: claude-opus-5-5 } }', '')
          .replace(
            'provider: claude, model: claude-opus-5-5,',
            'provider: gemini, model: gemini-flash,',
          ),
      ),
    ).toEqual([['schema', 5]])
    expect(codes(valid.replace('max_cost_usd_per_day: 20', 'max_cost_usd_per_day: -1'))).toEqual([
      ['invalid_limit', 7],
    ])
    expect(codes(valid.replace('roles:', 'rolez:'))[0]?.[0]).toBe('schema')
  })

  it('needs a provider that takes images for the explorer', () => {
    const providers = {
      ...DEFAULT_PROVIDER_CAPABILITIES,
      copilot: { enabled: true, vision: false },
    }
    // A capability without optIn needs no tenant flag: the server alone decides.
    expect(codes(valid.replace('provider: gemini', 'provider: copilot'), { providers })).toEqual([
      ['vision_required', 3],
    ])
    // Copilot as writer is fine: the writer reads the trace as text.
    expect(codes(valid.replace('provider: claude,', 'provider: copilot,'), { providers })).toEqual(
      [],
    )
  })

  it('takes prices from the tenant before the platform table', () => {
    const source = `${valid}prices:\n  gemini-flash: { input: 0.3, output: 2.5 }\n  claude-opus-5-5: { input: 4, output: 20 }\n`
    expect(codes(source, { platformHasPrice: () => false })).toEqual([])
  })

  it('takes a price per request for providers billed by request (Copilot, D47)', () => {
    const priced = (price: string) =>
      codes(
        `${valid}prices:\n  gemini-flash: ${price}\n  claude-opus-5-5: { input: 4, output: 20 }\n`,
        {
          platformHasPrice: () => false,
        },
      )
    expect(priced('{ input: 0, output: 0, per_request: 0.04 }')).toEqual([])
    expect(priced('{ input: 0, output: 0, per_request: -1 }').map(([code]) => code)).toEqual([
      'schema',
    ])
  })

  it('accepts the fake providers only when the server enables them', () => {
    const fake = `schema: coral/brains@1\nroles: { explorer: { provider: fake, model: fake } }\nfallback: [fake-alt]\nproviders: { fake-alt: { model: fake } }\n`
    expect(codes(fake)).toEqual([
      ['provider_disabled', 2],
      ['provider_disabled', 3],
    ])
    const providers = {
      ...DEFAULT_PROVIDER_CAPABILITIES,
      fake: { enabled: true, vision: true },
      'fake-alt': { enabled: true, vision: true },
    }
    expect(codes(fake, { providers })).toEqual([])
    // The file CORAL_BRAINS_DEFAULT points at in dev, E2E and the CI.
    expect(codes(examples['brains.fake.yaml'] ?? '', { providers })).toEqual([])
  })

  it('turns Copilot on only with the server flag and the tenant flag (FR-009)', () => {
    const providers = {
      ...DEFAULT_PROVIDER_CAPABILITIES,
      copilot: { enabled: true, vision: false, optIn: true },
    }
    const writer = valid.replace('provider: claude,', 'provider: copilot,')
    expect(codes(writer, { providers })).toEqual([['provider_disabled', 4]])
    const optedIn = writer.replace(
      'providers: { claude: { model: claude-opus-5-5 } }',
      'providers: { claude: { model: claude-opus-5-5 }, copilot: { enabled: true } }',
    )
    expect(codes(optedIn, { providers })).toEqual([])
    expect(codes(optedIn)).toEqual([['provider_disabled', 4]])
    // Any provider can be turned off by the tenant.
    const off = valid.replace(
      'providers: { claude: { model: claude-opus-5-5 } }',
      'providers: { claude: { model: claude-opus-5-5, enabled: false } }',
    )
    expect(codes(off)).toEqual([
      ['provider_disabled', 4],
      ['provider_disabled', 5],
    ])
  })

  it('checks examples/brains.example.yaml: valid once Copilot is enabled', () => {
    expect(codes(example)).toEqual([['provider_disabled', 8]])
    const providers = {
      ...DEFAULT_PROVIDER_CAPABILITIES,
      copilot: { enabled: true, vision: false },
    }
    expect(codes(example, { providers })[0]?.[0]).toBe('schema') // writer: copilot has no model
  })
})
