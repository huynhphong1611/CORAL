import Anthropic from '@anthropic-ai/sdk'
import { EFFORTS } from '@coral/shared'
import {
  ProviderError,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
  type ProviderErrorKind,
  type ToolCall,
  type ToolSpec,
} from '../brain'
import { strictSchema } from './json-schema'

export interface ClaudeAdapterOptions {
  apiKey: string
  /** Tests pass a fake `fetch`; the global one otherwise. */
  fetch?: typeof fetch
  baseURL?: string
  /** Longest answer in tokens (default 16 000: a decision or a test plan is far shorter). */
  maxTokens?: number
  /** Retries of the SDK on 429/5xx/connection errors before the router falls back (default 1). */
  maxRetries?: number
}

const DEFAULT_MAX_TOKENS = 16_000

type Effort = NonNullable<Anthropic.OutputConfig['effort']>
const isEffort = (value: string | undefined): value is Effort =>
  (EFFORTS as readonly string[]).includes(value ?? '')

/** The turns of the conversation as Claude takes them (tool results ride in a user turn). */
function toMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  return messages.map((message): Anthropic.MessageParam => {
    if (message.role === 'user') {
      return {
        role: 'user',
        content: [
          ...(message.images ?? []).map((image): Anthropic.ImageBlockParam => ({
            type: 'image',
            source: { type: 'base64', media_type: image.mediaType, data: image.data },
          })),
          { type: 'text', text: message.text },
        ],
      }
    }
    if (message.role === 'tool') {
      return {
        role: 'user',
        content: message.results.map((result): Anthropic.ToolResultBlockParam => ({
          type: 'tool_result',
          tool_use_id: result.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        })),
      }
    }
    // Claude's own turn goes back as it came, thinking blocks included (same conversation).
    if (Array.isArray(message.providerState)) {
      return { role: 'assistant', content: message.providerState as Anthropic.ContentBlockParam[] }
    }
    return {
      role: 'assistant',
      content: [
        ...(message.text ? [{ type: 'text' as const, text: message.text }] : []),
        ...(message.toolCalls ?? []).map((call): Anthropic.ToolUseBlockParam => ({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.args,
        })),
      ],
    }
  })
}

/** A tool with `strict: true` when its schema can be made strict; as declared otherwise. */
function toTool(spec: ToolSpec): Anthropic.Tool {
  const strict = strictSchema(spec.inputSchema)
  return {
    name: spec.name,
    description: spec.description,
    input_schema: (strict ?? spec.inputSchema) as Anthropic.Tool.InputSchema,
    ...(strict ? { strict: true } : {}),
  }
}

/** The request as `messages.create` takes it (research R2). */
export function claudeParams(
  request: ChatRequest,
  maxTokens = DEFAULT_MAX_TOKENS,
): Anthropic.MessageCreateParamsNonStreaming {
  const effort = request.options.effort
  const schema = strictSchema(request.outputSchema)
  if (!schema) {
    throw new ProviderError('bad_request', 'the answer schema cannot be sent to Claude')
  }
  return {
    model: request.model,
    max_tokens: maxTokens,
    // The stable part (role, AGENTS.md, skills) first and cached; what changes every call after.
    system: [
      { type: 'text', text: request.system.stable, cache_control: { type: 'ephemeral' } },
      ...(request.system.volatile
        ? [{ type: 'text' as const, text: request.system.volatile }]
        : []),
    ],
    messages: toMessages(request.messages),
    ...(request.tools.length > 0
      ? {
          tools: request.tools.map(toTool),
          // Forced tool use is refused by current models: `auto`, or `none` for the final answer.
          tool_choice: { type: request.toolChoice },
        }
      : {}),
    output_config: {
      format: { type: 'json_schema', schema },
      ...(isEffort(effort) ? { effort } : {}),
    },
  }
}

const STOPS: Partial<Record<string, ChatResponse['stop']>> = {
  end_turn: 'end',
  stop_sequence: 'end',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  model_context_window_exceeded: 'max_tokens',
  refusal: 'refusal',
}

/** Claude's answer in the provider-neutral form. */
export function fromClaude(message: Anthropic.Message): ChatResponse {
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
  const toolCalls: ToolCall[] = message.content
    .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
    .map((block) => ({ id: block.id, name: block.name, args: block.input }))
  const stop = STOPS[message.stop_reason ?? ''] ?? 'end'
  const usage = message.usage
  return {
    kind: stop === 'tool_use' && toolCalls.length > 0 ? 'tool_calls' : 'final',
    ...(text ? { text } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    usage: {
      // Cache writes are input too; cache reads are billed at the cached price.
      input: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
      output: usage.output_tokens,
      cachedInput: usage.cache_read_input_tokens ?? 0,
    },
    stop,
    providerState: message.content,
  }
}

/** The SDK's typed errors in the router's terms: everything but `bad_request` falls back. */
export function claudeError(error: unknown): ProviderError {
  const message = error instanceof Error ? error.message : String(error)
  const kind = ((): ProviderErrorKind => {
    if (error instanceof ProviderError) return error.kind
    // APIConnectionTimeoutError extends APIConnectionError, which extends APIError.
    if (error instanceof Anthropic.APIConnectionError) return 'timeout'
    if (error instanceof Anthropic.APIUserAbortError) return 'timeout'
    if (error instanceof Anthropic.RateLimitError) return 'rate_limited'
    if (error instanceof Anthropic.AuthenticationError) return 'auth'
    if (error instanceof Anthropic.PermissionDeniedError) return 'auth'
    // An unknown model for this key: another provider may still answer.
    if (error instanceof Anthropic.NotFoundError) return 'provider_error'
    if (error instanceof Anthropic.BadRequestError) return 'bad_request'
    if (error instanceof Anthropic.APIError) {
      const status: unknown = error.status
      if (status === 402) return 'auth'
      if (typeof status === 'number' && status >= 400 && status < 500) return 'bad_request'
    }
    return 'provider_error'
  })()
  return error instanceof ProviderError
    ? error
    : new ProviderError(kind, `claude: ${message}`, { cause: error })
}

/**
 * The `claude` adapter (`@anthropic-ai/sdk`, research R2): images as base64 blocks, tools with
 * `strict: true` and `tool_choice` `auto` (`none` on the final round), the answer forced to JSON
 * by `output_config.format`, the stable system part cached. Model and effort come from the
 * tenant's brains config — never from this file.
 */
export function createClaudeAdapter(options: ClaudeAdapterOptions): ProviderAdapter {
  const client = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: options.maxRetries ?? 1,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  })
  return {
    id: 'claude',
    vision: true,
    async chat(request) {
      const params = claudeParams(request, options.maxTokens)
      let message: Anthropic.Message
      try {
        message = await client.messages.create(params, { timeout: request.options.timeoutMs })
      } catch (error) {
        throw claudeError(error)
      }
      return fromClaude(message)
    },
  }
}
