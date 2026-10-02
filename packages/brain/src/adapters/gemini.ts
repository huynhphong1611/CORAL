import {
  ApiError,
  FinishReason,
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Part,
} from '@google/genai'
import {
  ProviderError,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
  type ProviderErrorKind,
  type ToolCall,
  type Usage,
} from '../brain'
import { strictSchema } from './json-schema'

export interface GeminiAdapterOptions {
  apiKey: string
  /** Tests pass a fake `fetch`; the global one otherwise. */
  fetch?: typeof fetch
  baseUrl?: string
  /** Longest answer in tokens (default 16 000). */
  maxTokens?: number
  /** HTTP attempts of the SDK on 429/5xx before the router falls back (default 2). */
  attempts?: number
}

const DEFAULT_MAX_TOKENS = 16_000
/** Ids of calls Gemini gave without one: ours, never sent back as an id. */
const LOCAL_ID = 'gemini-local-'

const LEVELS: Record<string, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
  xhigh: ThinkingLevel.HIGH,
  max: ThinkingLevel.HIGH,
}

/** The conversation as Gemini takes it: tool results are `functionResponse` parts of a user turn. */
function toContents(messages: ChatMessage[]): Content[] {
  return messages.map((message): Content => {
    if (message.role === 'user') {
      return {
        role: 'user',
        parts: [
          ...(message.images ?? []).map((image): Part => ({
            inlineData: { mimeType: image.mediaType, data: image.data },
          })),
          { text: message.text },
        ],
      }
    }
    if (message.role === 'tool') {
      return {
        role: 'user',
        parts: message.results.map((result): Part => ({
          functionResponse: {
            ...(result.id.startsWith(LOCAL_ID) ? {} : { id: result.id }),
            name: result.name,
            response: result.isError ? { error: result.content } : { output: result.content },
          },
        })),
      }
    }
    // Gemini's own turn goes back as it came: its thought signatures must stay with the calls.
    if (isContent(message.providerState)) return message.providerState
    return {
      role: 'model',
      parts: [
        ...(message.text ? [{ text: message.text }] : []),
        ...(message.toolCalls ?? []).map((call): Part => ({
          functionCall: {
            ...(call.id.startsWith(LOCAL_ID) ? {} : { id: call.id }),
            name: call.name,
            args: (call.args ?? {}) as Record<string, unknown>,
          },
        })),
      ],
    }
  })
}

const isContent = (value: unknown): value is Content =>
  typeof value === 'object' && value !== null && Array.isArray((value as Content).parts)

/** What one call asks: with tools and/or the JSON answer (both, or one per phase). */
function geminiConfig(
  request: ChatRequest,
  maxTokens: number,
  phase: { tools: boolean; json: boolean },
): GenerateContentConfig {
  const level = LEVELS[request.options.effort ?? '']
  const schema = strictSchema(request.outputSchema, { constAsEnum: true })
  if (phase.json && !schema) {
    throw new ProviderError('bad_request', 'the answer schema cannot be sent to Gemini')
  }
  return {
    systemInstruction: {
      parts: [
        { text: request.system.stable },
        ...(request.system.volatile ? [{ text: request.system.volatile }] : []),
      ],
    },
    maxOutputTokens: maxTokens,
    httpOptions: { timeout: request.options.timeoutMs },
    ...(level ? { thinkingConfig: { thinkingLevel: level } } : {}),
    ...(phase.tools && request.tools.length > 0
      ? {
          tools: [
            {
              functionDeclarations: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parametersJsonSchema: tool.inputSchema,
              })),
            },
          ],
          toolConfig: {
            functionCallingConfig: {
              mode:
                request.toolChoice === 'none'
                  ? FunctionCallingConfigMode.NONE
                  : FunctionCallingConfigMode.AUTO,
            },
          },
        }
      : {}),
    ...(phase.json ? { responseMimeType: 'application/json', responseJsonSchema: schema } : {}),
  }
}

const REFUSALS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
])

function usageOf(response: GenerateContentResponse): Usage {
  const meta = response.usageMetadata
  const cached = meta?.cachedContentTokenCount ?? 0
  return {
    // The prompt count includes what was read from the cache.
    input: (meta?.promptTokenCount ?? 0) - cached + (meta?.toolUsePromptTokenCount ?? 0),
    // Thinking is billed as output.
    output: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
    cachedInput: cached,
  }
}

/** Gemini's answer in the provider-neutral form. */
export function fromGemini(response: GenerateContentResponse): ChatResponse {
  const usage = usageOf(response)
  const candidate = response.candidates?.[0]
  if (!candidate) {
    // No candidate at all: the prompt itself was blocked.
    return { kind: 'final', usage, stop: response.promptFeedback?.blockReason ? 'refusal' : 'end' }
  }
  const parts = candidate.content?.parts ?? []
  const text = parts
    .filter((part) => part.text !== undefined && !part.thought)
    .map((part) => part.text)
    .join('')
  let local = 0
  const toolCalls: ToolCall[] = parts.flatMap((part) =>
    part.functionCall?.name
      ? [
          {
            id: part.functionCall.id ?? `${LOCAL_ID}${(local += 1)}`,
            name: part.functionCall.name,
            args: part.functionCall.args ?? {},
          },
        ]
      : [],
  )
  const reason: string = candidate.finishReason ?? FinishReason.STOP
  const stop: ChatResponse['stop'] = REFUSALS.has(reason)
    ? 'refusal'
    : reason === String(FinishReason.MAX_TOKENS)
      ? 'max_tokens'
      : toolCalls.length > 0
        ? 'tool_use'
        : 'end'
  return {
    kind: stop === 'tool_use' ? 'tool_calls' : 'final',
    ...(text ? { text } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    usage,
    stop,
    ...(candidate.content ? { providerState: candidate.content } : {}),
  }
}

/** A 400 saying this model takes no JSON mode together with function calling. */
const isJsonWithToolsRefused = (error: unknown) =>
  error instanceof ApiError &&
  error.status === 400 &&
  /function call/i.test(error.message) &&
  /(mime|json)/i.test(error.message)

/** The SDK's errors in the router's terms: everything but `bad_request` falls back. */
export function geminiError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error
  const message = error instanceof Error ? error.message : String(error)
  const kind = ((): ProviderErrorKind => {
    if (error instanceof ApiError) {
      if (error.status === 429) return 'rate_limited'
      if (error.status === 401 || error.status === 403) return 'auth'
      // An unknown model for this key: another provider may still answer.
      if (error.status === 404) return 'provider_error'
      if (error.status >= 400 && error.status < 500) return 'bad_request'
      return 'provider_error'
    }
    // fetch failed, aborted or timed out before an HTTP answer.
    if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {
      return 'timeout'
    }
    return 'provider_error'
  })()
  return new ProviderError(kind, `gemini: ${message}`, { cause: error })
}

const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cachedInput: a.cachedInput + b.cachedInput,
})

/**
 * The `gemini` adapter (`@google/genai`, research R2): `generateContent` with images as
 * `inlineData`, tools as `functionDeclarations`, the answer as JSON (`responseMimeType` +
 * `responseJsonSchema`). A model that takes no JSON mode together with function calling is
 * asked in two phases from then on: tool rounds without JSON, then the answer in JSON without
 * tools. Model and effort (thinking level) come from the tenant's brains config.
 */
export function createGeminiAdapter(options: GeminiAdapterOptions): ProviderAdapter {
  const ai = new GoogleGenAI({
    apiKey: options.apiKey,
    httpOptions: {
      retryOptions: { attempts: options.attempts ?? 2 },
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    },
  })
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  /** Models seen refusing JSON mode with function calling. */
  const twoPhase = new Set<string>()

  async function generate(request: ChatRequest, phase: { tools: boolean; json: boolean }) {
    try {
      return await ai.models.generateContent({
        model: request.model,
        contents: toContents(request.messages),
        config: geminiConfig(request, maxTokens, phase),
      })
    } catch (error) {
      // Left to chat(), which switches this model to two phases.
      if (phase.tools && phase.json && request.tools.length > 0 && isJsonWithToolsRefused(error)) {
        throw error
      }
      throw geminiError(error)
    }
  }

  async function inTwoPhases(request: ChatRequest): Promise<ChatResponse> {
    const first = fromGemini(await generate(request, { tools: true, json: false }))
    if (first.kind === 'tool_calls' || first.stop !== 'end') return first
    // No more tools wanted: the answer again, now held to the JSON schema.
    const answer = fromGemini(await generate(request, { tools: false, json: true }))
    return { ...answer, usage: addUsage(first.usage, answer.usage) }
  }

  return {
    id: 'gemini',
    vision: true,
    async chat(request) {
      const offersTools = request.tools.length > 0 && request.toolChoice === 'auto'
      // In two phases, the final round is the second phase alone: JSON, no tools.
      const twoPhased = () =>
        offersTools
          ? inTwoPhases(request)
          : generate(request, { tools: false, json: true }).then(fromGemini)
      if (twoPhase.has(request.model)) return twoPhased()
      try {
        return fromGemini(await generate(request, { tools: true, json: true }))
      } catch (error) {
        if (!isJsonWithToolsRefused(error)) throw geminiError(error)
        twoPhase.add(request.model)
        return twoPhased()
      }
    },
  }
}
