import { z } from 'zod'
import { BRAIN_PROVIDER_IDS, brainsSchema } from '../brains/schema'
import { timestamp } from './common'

/** Error codes added in Phase 3 (contracts/rest-api-phase3.md). */
export const PHASE3_ERROR_CODES = [
  'brains_not_configured',
  'daily_limit_reached',
  'no_cases',
  'stdio_not_allowed',
  'too_many_explorations',
] as const

// Values of data-model §1, verbatim: the DB check constraints use the same lists.

/** Roles that call the AI in Phase 3; `healer` and `popup` come with Phase 4. */
export const BRAIN_CALL_ROLES = ['explorer', 'writer'] as const
export type BrainCallRole = (typeof BRAIN_CALL_ROLES)[number]

export const BRAIN_CALL_ERRORS = [
  'timeout',
  'rate_limited',
  'auth',
  'refusal',
  'invalid_output',
  'provider_error',
  'budget',
] as const
export type BrainCallError = (typeof BRAIN_CALL_ERRORS)[number]

export const BRAIN_CALL_REF_TYPES = ['exploration', 'import_job'] as const
export type BrainCallRefType = (typeof BRAIN_CALL_REF_TYPES)[number]

export const TOOL_CALL_ERRORS = [
  'not_allowed',
  'side_effects_disabled',
  'timeout',
  'server_error',
] as const
export type ToolCallError = (typeof TOOL_CALL_ERRORS)[number]

// ---- brains.yaml ---------------------------------------------------------------------------------

export const BRAINS_CONFIG_SOURCES = ['tenant', 'platform', 'none'] as const

/** `GET|PUT /brains/config`: where the config comes from and what each provider can do here. */
export const brainsConfigViewSchema = z.object({
  source: z.enum(BRAINS_CONFIG_SOURCES),
  yaml: z.string(),
  config: brainsSchema.nullable(),
  providers: z.array(
    z.object({ id: z.enum(BRAIN_PROVIDER_IDS), enabled: z.boolean(), vision: z.boolean() }),
  ),
})
export type BrainsConfigView = z.infer<typeof brainsConfigViewSchema>

// ---- usage ---------------------------------------------------------------------------------------

export const USAGE_GROUPS = ['day', 'role', 'provider'] as const

/** `GET /usage/ai`: days are UTC dates; `to` is inclusive. */
export const usageQuerySchema = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    group: z.enum(USAGE_GROUPS).default('day'),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from is after to' })
export type UsageQuery = z.infer<typeof usageQuerySchema>

const tokens = z.number().int().nonnegative()
const usd = z.number().nonnegative()

export const usageSchema = z.object({
  rows: z.array(
    z.object({
      key: z.string(),
      calls: z.number().int().nonnegative(),
      tokens_in: tokens,
      tokens_out: tokens,
      cost_usd: usd,
    }),
  ),
  total_cost_usd: usd,
  // `limit_usd` is null while the tenant has no brains config.
  today: z.object({ cost_usd: usd, limit_usd: usd.nullable() }),
})
export type Usage = z.infer<typeof usageSchema>

// ---- one AI call ---------------------------------------------------------------------------------

/**
 * What was sent to and answered by the AI in one attempt (contracts/brain.md §6, FR-006a), kept
 * 30 days with secrets masked. The stable part of the system prompt is kept as a hash only.
 * `image` is a storage key in the stored JSON and a presigned URL in API responses.
 */
export const brainCallContentSchema = z.object({
  role: z.enum(BRAIN_CALL_ROLES),
  provider: z.enum(BRAIN_PROVIDER_IDS),
  model: z.string(),
  attempt: z.number().int().positive(),
  system: z.object({ stable_hash: z.string(), volatile: z.string() }),
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant']),
      text: z.string(),
      image: z.string().optional(),
    }),
  ),
  rounds: z.array(
    z.object({
      tool_calls: z.array(z.object({ name: z.string(), args: z.unknown(), result: z.string() })),
    }),
  ),
  // Raw final answer; null when the provider failed before answering.
  answer: z.string().nullable(),
  validation_errors: z.array(z.string()),
  // The answer once it passed its Zod schema.
  decision: z.unknown().optional(),
})
export type BrainCallContent = z.infer<typeof brainCallContentSchema>

export const toolCallSchema = z.object({
  id: z.uuid(),
  mcp_server: z.string(),
  tool: z.string(),
  args_redacted: z.unknown(),
  ok: z.boolean(),
  blocked: z.boolean(),
  error: z.enum(TOOL_CALL_ERRORS).nullable(),
  latency_ms: z.number().int().nonnegative(),
  created_at: timestamp,
})
export type ToolCall = z.infer<typeof toolCallSchema>

/** `GET /brain-calls/:id`; `content` is null once it expired (30 days). */
export const brainCallSchema = z.object({
  id: z.uuid(),
  role: z.enum(BRAIN_CALL_ROLES),
  provider: z.enum(BRAIN_PROVIDER_IDS),
  model: z.string(),
  attempt: z.number().int().positive(),
  ok: z.boolean(),
  error: z.enum(BRAIN_CALL_ERRORS).nullable(),
  tokens_in: tokens,
  tokens_out: tokens,
  cost_usd: usd,
  latency_ms: z.number().int().nonnegative(),
  created_at: timestamp,
  content: brainCallContentSchema.nullable(),
  tool_calls: z.array(toolCallSchema),
})
export type BrainCall = z.infer<typeof brainCallSchema>
