import {
  VISION_ROLES,
  fallbackModel,
  roleOf,
  sha256Hex,
  type BrainsConfig,
  type ModelPrice,
  type api,
} from '@coral/shared'
import {
  BrainOutputError,
  BrainUnavailableError,
  BudgetExceededError,
  ProviderError,
  type Brain,
  type BrainCallRole,
  type CallContext,
  type ChatMessage,
  type ProviderAdapter,
  type ToolOutcome,
  type Usage,
} from './brain'
import { decidePrompt, describePrompt, writeTestPrompt, type Prompt } from './prompts'
import { DEFAULT_TIMEOUT_MS, structuredChat, type AttemptRecord } from './structured'

/** One attempt as the server stores it: a `brain_calls` row, its content and its tool calls. */
export interface CallRecord {
  role: BrainCallRole
  provider: string
  model: string
  /** 1, 2, … across re-asks and fallbacks of one decision (D41). */
  attempt: number
  usage: Usage
  costUsd: number
  latencyMs: number
  ok: boolean
  error?: api.BrainCallError
  ref: CallContext['ref']
  /** `BrainCallContent` before secrets are masked and images become storage keys (FR-006a). */
  content: api.BrainCallContent
  toolCalls: { name: string; args: unknown; outcome: ToolOutcome }[]
}

export interface RouterDeps {
  config: BrainsConfig
  /** The adapters this server can use, by provider id (keys already resolved). */
  adapters: Partial<Record<string, ProviderAdapter>>
  /** USD per million tokens: the tenant's `prices` over the platform table. */
  price: (model: string) => ModelPrice | undefined
  /** What the tenant spent today (UTC), asked before every provider call (FR-007). */
  dailySpentUsd: (tenantId: string) => Promise<number>
  /** Stores each attempt, failed ones included (`brain_calls`, content, `tool_calls`). */
  record: (call: CallRecord) => Promise<void>
  timeoutMs?: number
}

/** Cost of a call: token counts × the model's price per million tokens (FR-006). */
export function costOf(usage: Usage, price: ModelPrice): number {
  const cached = price.cached_input ?? price.input
  return (
    (usage.input * price.input + usage.cachedInput * cached + usage.output * price.output) / 1e6
  )
}

const errorOf = (error: AttemptRecord['error']): api.BrainCallError | undefined =>
  error === undefined ? undefined : error === 'bad_request' ? 'provider_error' : error

/** The conversation as stored: user and assistant turns; tool results live in `rounds`. */
function contentMessages(messages: ChatMessage[]): api.BrainCallContent['messages'] {
  const out: api.BrainCallContent['messages'] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const image = message.images?.[0]?.ref
      out.push({ role: 'user', text: message.text, ...(image ? { image } : {}) })
    } else if (message.role === 'assistant') {
      const calls = message.toolCalls?.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(', ')
      out.push({ role: 'assistant', text: message.text ?? (calls ? `tools: ${calls}` : '') })
    }
  }
  return out
}

interface Candidate {
  provider: string
  model: string
  effort?: string
}

/** The role's provider, then `fallback` in order, each provider once (research R4). */
export function candidatesFor(config: BrainsConfig, role: BrainCallRole): Candidate[] {
  const resolved = roleOf(config, role)
  const chain: Candidate[] = []
  if (resolved) {
    chain.push({
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.effort ? { effort: resolved.effort } : {}),
    })
  }
  for (const provider of config.fallback) {
    if (chain.some((c) => c.provider === provider)) continue
    const model = fallbackModel(config, provider)
    if (model) chain.push({ provider, model })
  }
  return chain
}

/**
 * The router (SPEC §14.3, research R4): routes each call by role, checks the daily limit and the
 * activity's budget before every provider call, falls back on any provider failure but a bad
 * request, and records every attempt with its cost.
 */
export function createBrain(deps: RouterDeps): Brain {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function checkLimits(ctx: CallContext) {
    const daily = deps.config.limits.max_cost_usd_per_day
    if ((await deps.dailySpentUsd(ctx.tenantId)) >= daily) {
      throw new BudgetExceededError('daily', `the daily AI limit of $${daily} is reached`)
    }
    if ((await ctx.budget.spentUsd()) >= ctx.budget.maxCostUsd) {
      throw new BudgetExceededError(
        'activity',
        `the budget of $${ctx.budget.maxCostUsd} of this ${ctx.ref.type} is spent`,
      )
    }
  }

  /** The adapter with the limits checked and a hard timeout around each call. */
  function guarded(adapter: ProviderAdapter, ctx: CallContext): ProviderAdapter {
    return {
      ...adapter,
      async chat(request) {
        await checkLimits(ctx)
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new ProviderError('timeout', `no answer within ${timeoutMs} ms`)),
            timeoutMs + 5000,
          )
        })
        try {
          return await Promise.race([adapter.chat(request), timeout])
        } finally {
          clearTimeout(timer)
        }
      },
    }
  }

  async function route<T>(role: BrainCallRole, prompt: Prompt<T>, ctx: CallContext): Promise<T> {
    let attempt = 0
    let lastError: unknown
    const stableHash = sha256Hex(prompt.system.stable)
    for (const candidate of candidatesFor(deps.config, role)) {
      const adapter = deps.adapters[candidate.provider]
      if (!adapter) {
        lastError = new ProviderError('auth', `provider "${candidate.provider}" is not available`)
        continue
      }
      if (VISION_ROLES.includes(role) && !adapter.vision) continue
      const price = deps.price(candidate.model)
      if (!price) {
        // Never call a model whose cost cannot be counted (FR-006).
        lastError = new ProviderError('bad_request', `no price for model "${candidate.model}"`)
        continue
      }
      try {
        const { value } = await structuredChat({
          adapter: guarded(adapter, ctx),
          model: candidate.model,
          ...(candidate.effort ? { effort: candidate.effort } : {}),
          prompt,
          tools: ctx.tools,
          timeoutMs,
          onAttempt: async (a) => {
            attempt += 1
            const error = errorOf(a.error)
            await deps.record({
              role,
              provider: candidate.provider,
              model: candidate.model,
              attempt,
              usage: a.usage,
              costUsd: costOf(a.usage, price),
              latencyMs: a.latencyMs,
              ok: a.ok,
              ...(error ? { error } : {}),
              ref: ctx.ref,
              content: {
                role,
                provider: adapter.id,
                model: candidate.model,
                attempt,
                system: { stable_hash: stableHash, volatile: a.system.volatile },
                messages: contentMessages(a.messages),
                rounds: a.rounds.map((r) => ({
                  tool_calls: r.tool_calls.map((c) => ({
                    name: c.name,
                    args: c.args,
                    result: c.result,
                  })),
                })),
                answer: a.answer,
                validation_errors: a.validationErrors,
                ...(a.decision !== undefined ? { decision: a.decision } : {}),
              },
              toolCalls: a.rounds.flatMap((r) =>
                r.tool_calls.map((c) => ({ name: c.name, args: c.args, outcome: c.outcome })),
              ),
            })
          },
        })
        return value
      } catch (error) {
        if (error instanceof BudgetExceededError) throw error
        if (error instanceof ProviderError && error.kind === 'bad_request') throw error
        if (!(error instanceof ProviderError) && !(error instanceof BrainOutputError)) throw error
        lastError = error
      }
    }
    throw new BrainUnavailableError(
      `no provider could answer for ${role}${
        lastError instanceof Error ? `: ${lastError.message}` : ''
      }`,
      { cause: lastError },
    )
  }

  return {
    describeScreen: (input, ctx) => route('explorer', describePrompt(input, ctx.knowledge), ctx),
    nextAction: (input, ctx) => route('explorer', decidePrompt(input, ctx.knowledge), ctx),
    writeTest: (input, ctx) => route('writer', writeTestPrompt(input, ctx.knowledge), ctx),
  }
}
