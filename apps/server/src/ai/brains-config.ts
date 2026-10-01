import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import {
  BRAIN_PROVIDER_IDS,
  DEFAULT_PROVIDER_CAPABILITIES,
  brainsSchema,
  modelPriceSchema,
  parseYaml,
  validateBrainsSource,
  type BrainProviderId,
  type BrainsConfig,
  type ModelPrice,
  type ProviderCapability,
  type ValidationResult,
} from '@coral/shared'
import { z } from 'zod'
import type { ServerConfig } from '../config'
import type { TenantRepos } from '../repos'
import type { SecretSource } from '../runs/secrets'

export const AI_PRICES_SCHEMA_ID = 'coral/ai-prices@1'

const priceTableSchema = z.strictObject({
  schema: z.literal(AI_PRICES_SCHEMA_ID),
  models: z.record(z.string().min(1), modelPriceSchema),
})

/** The platform's price table (`apps/server/ai-prices.yaml` or `CORAL_AI_PRICES`). */
export function readPriceTable(path: string): Record<string, ModelPrice> {
  const parsed = parseYaml(readFileSync(path, 'utf8'))
  const table = priceTableSchema.safeParse(parsed.value)
  if (parsed.errors.length > 0 || !table.success) {
    throw new Error(
      `Invalid AI price table ${path}: ${
        parsed.errors[0]?.message ?? z.prettifyError(table.error ?? new z.ZodError([]))
      }`,
    )
  }
  return table.data.models
}

export type BrainsSourceKind = 'tenant' | 'platform' | 'none'

/** Where a tenant's brains config comes from (contracts/brains-yaml.md "Nguồn cấu hình"). */
export interface ResolvedBrains {
  source: BrainsSourceKind
  yaml: string
  config: BrainsConfig | null
}

/**
 * Brains settings of the server: which providers it can use, the price table, the platform's
 * default config and the provider keys (research R4). Model names and prices are data, never code.
 */
export class BrainsSettings {
  private prices?: Record<string, ModelPrice>
  private platform?: { yaml: string; config: BrainsConfig } | null

  constructor(
    private readonly options: {
      ai: ServerConfig['ai']
      secrets: SecretSource
      /** Base of a relative CORAL_BRAINS_DEFAULT (the repo root in dev). */
      cwd?: string
    },
  ) {}

  /** What this server can run: fake only with CORAL_BRAIN_FAKE, Copilot only with its flag. */
  capabilities(): Record<BrainProviderId, ProviderCapability> {
    const { ai } = this.options
    return {
      ...DEFAULT_PROVIDER_CAPABILITIES,
      copilot: { ...DEFAULT_PROVIDER_CAPABILITIES.copilot, enabled: ai.copilotEnabled },
      fake: { ...DEFAULT_PROVIDER_CAPABILITIES.fake, enabled: ai.fakeBrains },
      'fake-alt': { ...DEFAULT_PROVIDER_CAPABILITIES['fake-alt'], enabled: ai.fakeBrains },
    }
  }

  /** `GET /brains/config` `providers`: every provider id with what it can do here. */
  providerList(): { id: BrainProviderId; enabled: boolean; vision: boolean }[] {
    const capabilities = this.capabilities()
    return BRAIN_PROVIDER_IDS.filter(
      (id) => capabilities[id].enabled || (id !== 'fake' && id !== 'fake-alt'),
    ).map((id) => ({ id, enabled: capabilities[id].enabled, vision: capabilities[id].vision }))
  }

  priceTable(): Record<string, ModelPrice> {
    this.prices ??= readPriceTable(this.options.ai.pricesPath)
    return this.prices
  }

  /** The tenant's `prices` first, then the platform table. */
  price(config: BrainsConfig, model: string): ModelPrice | undefined {
    return config.prices[model] ?? this.priceTable()[model]
  }

  /** Checks a brains.yaml for this server: providers it runs, models it can price (FR-004). */
  validate(yaml: string, file = 'brains.yaml'): ValidationResult<BrainsConfig> {
    const table = this.priceTable()
    return validateBrainsSource(yaml, file, {
      providers: this.capabilities(),
      platformHasPrice: (model) => table[model] !== undefined,
    })
  }

  /** The platform default (`CORAL_BRAINS_DEFAULT`), checked once; a broken file stops the call. */
  platformDefault(): { yaml: string; config: BrainsConfig } | null {
    if (this.platform !== undefined) return this.platform
    const path = this.options.ai.brainsDefaultPath
    if (!path) return (this.platform = null)
    const file = isAbsolute(path) ? path : resolve(this.options.cwd ?? process.cwd(), path)
    const yaml = readFileSync(file, 'utf8')
    const result = this.validate(yaml, file)
    if (!result.valid || !result.value) {
      const first = result.errors[0]
      throw new Error(
        `CORAL_BRAINS_DEFAULT ${file} is not valid: ${first?.code} ${first?.message} (line ${first?.line})`,
      )
    }
    return (this.platform = { yaml, config: result.value })
  }

  /** Tenant config → platform default → none. */
  async resolve(repos: Pick<TenantRepos, 'settings'>): Promise<ResolvedBrains> {
    const stored = await repos.settings.brains()
    if (stored) {
      return { source: 'tenant', yaml: stored.yaml, config: brainsSchema.parse(stored.config) }
    }
    const platform = this.platformDefault()
    if (platform) return { source: 'platform', ...platform }
    return { source: 'none', yaml: '', config: null }
  }

  /**
   * The key of a provider: the tenant's own secret (`api_key_secret`, `CORAL_SECRET_<NAME>` in
   * dev, D19) or the platform key. Never logged nor returned by the API (FR-008).
   */
  apiKey(config: BrainsConfig, provider: string): string | undefined {
    const settings = config.providers[provider]
    const secret = settings?.api_key_secret ?? settings?.token_secret
    if (secret) return this.options.secrets.get([secret])[secret]
    const { keys } = this.options.ai
    if (provider === 'claude') return keys.anthropic
    if (provider === 'gemini') return keys.gemini
    return undefined
  }
}
