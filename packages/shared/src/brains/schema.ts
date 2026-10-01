import { z } from 'zod'
import { parseYaml } from '../testcase/parse'
import {
  schemaIssues,
  validateParsed,
  type CheckOutcome,
  type ValidationResult,
} from '../testcase/validate'

/**
 * `coral/brains@1` — which AI provider and model each role uses, the fallback order, the cost
 * limits and model prices of one tenant (SPEC §14.3, D20, D43; contracts/brains-yaml.md). The
 * server and the web check the same schema; model names live only in this configuration (P4).
 */
export const BRAINS_SCHEMA_ID = 'coral/brains@1'

/** AI roles of SPEC §14.3. Phase 3 calls explorer and writer; healer and popup come in Phase 4. */
export const BRAIN_ROLES = ['explorer', 'writer', 'healer', 'popup'] as const
export type BrainRole = (typeof BRAIN_ROLES)[number]
/** Roles that look at screenshots, so their provider must take images. */
export const VISION_ROLES: readonly BrainRole[] = ['explorer', 'popup']

/** Provider ids a brains.yaml may name (`fake*`: scripted, tests and CI only — D43). */
export const BRAIN_PROVIDER_IDS = ['claude', 'gemini', 'copilot', 'fake', 'fake-alt'] as const
export type BrainProviderId = (typeof BRAIN_PROVIDER_IDS)[number]

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const MAX_LIMIT_USD = 10_000
export const DEFAULT_LIMITS = {
  max_cost_usd_per_day: 20,
  max_cost_usd_per_exploration: 3,
  max_cost_usd_per_import: 10,
} as const

const nonEmpty = z.string().trim().min(1)
const secretName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'a secret name: [A-Za-z_][A-Za-z0-9_]*')
const usd = z.number()

const roleSchema = z.strictObject({
  provider: nonEmpty,
  model: nonEmpty.optional(),
  effort: z.enum(EFFORTS).optional(),
})

const providerSettingsSchema = z.strictObject({
  model: nonEmpty.optional(),
  api_key_secret: secretName.optional(),
  /** Copilot: the tenant's own Copilot token (FR-009). */
  token_secret: secretName.optional(),
  enabled: z.boolean().optional(),
})

/** USD per million tokens. */
export const modelPriceSchema = z.strictObject({
  input: z.number().min(0),
  output: z.number().min(0),
  cached_input: z.number().min(0).optional(),
  // USD per call, for providers billed by request (Copilot premium requests, D47).
  per_request: z.number().min(0).optional(),
})
export type ModelPrice = z.infer<typeof modelPriceSchema>

export const brainsSchema = z.strictObject({
  schema: z.literal(BRAINS_SCHEMA_ID),
  roles: z.strictObject({
    explorer: roleSchema,
    writer: roleSchema.optional(),
    healer: roleSchema.optional(),
    popup: roleSchema.optional(),
  }),
  fallback: z.array(nonEmpty).default([]),
  providers: z.record(nonEmpty, providerSettingsSchema).default({}),
  limits: z
    .strictObject({
      max_cost_usd_per_day: usd.default(DEFAULT_LIMITS.max_cost_usd_per_day),
      max_cost_usd_per_exploration: usd.default(DEFAULT_LIMITS.max_cost_usd_per_exploration),
      max_cost_usd_per_import: usd.default(DEFAULT_LIMITS.max_cost_usd_per_import),
    })
    .default({ ...DEFAULT_LIMITS }),
  prices: z.record(nonEmpty, modelPriceSchema).default({}),
})
export type BrainsConfig = z.infer<typeof brainsSchema>

/** What the checker knows about the providers this server can use (contracts/brains-yaml.md). */
export interface ProviderCapability {
  enabled: boolean
  vision: boolean
  /** The tenant must also turn it on with `providers.<id>.enabled: true` (Copilot, FR-009). */
  optIn?: boolean
}

export interface BrainsCheckOptions {
  /** Providers by id; ids missing here are unknown. Default: claude and gemini only. */
  providers?: Partial<Record<string, ProviderCapability>>
  /** Whether the platform price table has the model; without it prices are not checked. */
  platformHasPrice?: (model: string) => boolean
}

export const DEFAULT_PROVIDER_CAPABILITIES: Record<BrainProviderId, ProviderCapability> = {
  claude: { enabled: true, vision: true },
  gemini: { enabled: true, vision: true },
  // Images go as base64 blob attachments of the SDK (D47).
  copilot: { enabled: false, vision: true, optIn: true },
  fake: { enabled: false, vision: true },
  'fake-alt': { enabled: false, vision: true },
}

/** The provider and model a role runs on: `writer` falls back to `explorer` (§14.3). */
export interface ResolvedRole {
  provider: string
  model: string
  effort?: (typeof EFFORTS)[number]
}

export function roleOf(config: BrainsConfig, role: BrainRole): ResolvedRole | undefined {
  const settings = config.roles[role] ?? (role === 'writer' ? config.roles.explorer : undefined)
  if (!settings) return undefined
  const model = settings.model ?? config.providers[settings.provider]?.model
  if (!model) return undefined
  return {
    provider: settings.provider,
    model,
    ...(settings.effort ? { effort: settings.effort } : {}),
  }
}

/** The model a fallback provider runs: its `providers.<id>.model`, or a model a role names for it. */
export function fallbackModel(config: BrainsConfig, provider: string): string | undefined {
  const own = config.providers[provider]?.model
  if (own) return own
  for (const role of BRAIN_ROLES) {
    const settings = config.roles[role]
    if (settings?.provider === provider && settings.model) return settings.model
  }
  return undefined
}

type Issues = CheckOutcome<BrainsConfig>['issues']

function checkBrains(value: unknown, options: BrainsCheckOptions): CheckOutcome<BrainsConfig> {
  const parsed = brainsSchema.safeParse(value)
  if (!parsed.success) return { issues: schemaIssues(parsed.error) }
  const config = parsed.data
  const providers: Partial<Record<string, ProviderCapability>> =
    options.providers ?? DEFAULT_PROVIDER_CAPABILITIES
  const issues: Issues = []

  const checkProvider = (id: string, path: (string | number)[], role?: BrainRole): boolean => {
    const capability = providers[id]
    if (!capability) {
      issues.push({ path, code: 'unknown_provider', message: `unknown provider "${id}"` })
      return false
    }
    if (!capability.enabled) {
      issues.push({
        path,
        code: 'provider_disabled',
        message: `provider "${id}" is not enabled on this server`,
      })
      return false
    }
    const tenantFlag = config.providers[id]?.enabled
    if (tenantFlag === false || (capability.optIn && tenantFlag !== true)) {
      issues.push({
        path,
        code: 'provider_disabled',
        message: `provider "${id}" is turned off: set providers.${id}.enabled: true`,
      })
      return false
    }
    if (role && VISION_ROLES.includes(role) && !capability.vision) {
      issues.push({
        path,
        code: 'vision_required',
        message: `role ${role} needs a provider that takes images; "${id}" does not`,
      })
    }
    return true
  }

  const checkPrice = (model: string, path: (string | number)[]) => {
    if (!options.platformHasPrice) return
    if (config.prices[model] || options.platformHasPrice(model)) return
    issues.push({
      path,
      code: 'price_missing',
      message: `no price for model "${model}": add it under prices: (USD per million tokens)`,
    })
  }

  for (const role of BRAIN_ROLES) {
    const settings = config.roles[role]
    if (!settings) continue
    if (!checkProvider(settings.provider, ['roles', role, 'provider'], role)) continue
    const model = settings.model ?? config.providers[settings.provider]?.model
    if (!model) {
      issues.push({
        path: ['roles', role],
        code: 'schema',
        message: `role ${role} needs a model (here or under providers.${settings.provider}.model)`,
      })
      continue
    }
    checkPrice(model, settings.model ? ['roles', role, 'model'] : ['providers', settings.provider])
  }

  config.fallback.forEach((id, i) => {
    if (!checkProvider(id, ['fallback', i])) return
    const model = fallbackModel(config, id)
    if (!model) {
      issues.push({
        path: ['fallback', i],
        code: 'schema',
        message: `fallback provider "${id}" needs a model under providers.${id}.model`,
      })
      return
    }
    checkPrice(model, ['fallback', i])
  })

  for (const [key, amount] of Object.entries(config.limits)) {
    if (!(amount > 0 && amount <= MAX_LIMIT_USD)) {
      issues.push({
        path: ['limits', key],
        code: 'invalid_limit',
        message: `${key} must be more than 0 and at most ${MAX_LIMIT_USD} USD`,
      })
    }
  }
  return { value: config, issues }
}

/** Checks a brains.yaml text: problems carry line and column (FR-004). */
export function validateBrainsSource(
  source: string,
  file = 'brains.yaml',
  options: BrainsCheckOptions = {},
): ValidationResult<BrainsConfig> {
  return validateParsed(parseYaml(source), file, (value) => checkBrains(value, options))
}
