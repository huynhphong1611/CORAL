import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CopilotClient,
  defineTool,
  type MessageOptions,
  type PermissionRequestResult,
  type SessionConfig,
} from '@github/copilot-sdk'
import { EFFORTS } from '@coral/shared'
import {
  ProviderError,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
  type ProviderErrorKind,
  type Usage,
} from '../brain'
import { strictSchema } from './json-schema'

/** The usage of one model call of the session (`assistant.usage`). */
export interface CopilotUsageEvent {
  data: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    finishReason?: string
    contentFilterTriggered?: boolean
  }
}

/** What the adapter uses of a session; tests pass a fake. */
export interface CopilotSessionLike {
  on(eventType: 'assistant.usage', handler: (event: CopilotUsageEvent) => void): () => void
  sendAndWait(
    options: MessageOptions,
    timeout?: number,
  ): Promise<{ data: { content: string } } | undefined>
  disconnect(): Promise<void>
}

/** What the adapter uses of the SDK client; tests pass a fake. */
export interface CopilotClientLike {
  createSession(config: SessionConfig): Promise<CopilotSessionLike>
}

export interface CopilotAdapterOptions {
  /** The GitHub token: the tenant's `token_secret` or the platform's `CORAL_COPILOT_TOKEN`. */
  token: string
  /** Tests pass a fake client; the runtime shared by this server otherwise. */
  client?: CopilotClientLike
}

type Effort = NonNullable<SessionConfig['reasoningEffort']>
const isEffort = (value: string | undefined): value is Effort =>
  (EFFORTS as readonly string[]).includes(value ?? '')

/** A session's token lives this long for the runtime; one call ends far sooner. */
const TOKEN_SECONDS = 8 * 60 * 60
/** Copilot is an agent with shell and file tools: anything but coral's tools is refused. */
const DENY: PermissionRequestResult = { kind: 'denied-interactively-by-user' }

let shared: Promise<CopilotClient> | undefined

/**
 * One Copilot runtime for the whole server (its CLI ships in `@github/copilot-sdk-<platform>`);
 * each call's session carries the tenant's token, so tenants never share credentials.
 */
function sharedClient(): Promise<CopilotClient> {
  shared ??= (async () => {
    const client = new CopilotClient({ mode: 'empty', useLoggedInUser: false, logLevel: 'error' })
    await client.start()
    return client
  })().catch((error: unknown) => {
    shared = undefined
    throw error
  })
  return shared
}

/** The SDK client seen through the narrow interface the adapter uses. */
function sdkClient(client: CopilotClient): CopilotClientLike {
  return {
    async createSession(config) {
      const session = await client.createSession(config)
      return {
        on: (eventType, handler) => session.on(eventType, (event) => handler({ data: event.data })),
        sendAndWait: (message, timeout) => session.sendAndWait(message, timeout),
        disconnect: () => session.disconnect(),
      }
    },
  }
}

/** Stops the shared runtime, if it was started (server shutdown). */
export async function stopCopilotRuntime(): Promise<void> {
  const running = shared
  shared = undefined
  if (running) await (await running).stop().catch(() => undefined)
}

/**
 * The conversation as one prompt: a session starts afresh on every call, so earlier turns (a
 * re-ask after a broken answer) are written out before the last user message.
 */
function promptOf(messages: ChatMessage[]): string {
  const last = messages.at(-1)
  if (messages.length === 1 && last?.role === 'user') return last.text
  const lines = messages.slice(0, -1).map((message) => {
    if (message.role === 'user') return `User: ${message.text}`
    if (message.role === 'assistant') return `You answered: ${message.text ?? ''}`
    return `Tool results: ${message.results.map((r) => r.content).join('\n')}`
  })
  const now = last?.role === 'user' ? last.text : ''
  return `Conversation so far:\n\n${lines.join('\n\n')}\n\n${now}`
}

/** The images of the conversation as base64 blob attachments (`vision: true`, D47). */
const attachmentsOf = (messages: ChatMessage[]): MessageOptions['attachments'] =>
  messages.flatMap((message) =>
    message.role === 'user'
      ? (message.images ?? []).map((image) => ({
          type: 'blob' as const,
          data: image.data,
          mimeType: image.mediaType,
        }))
      : [],
  )

/** The SDK's errors (JSON-RPC, runtime) in the router's terms; only their message tells. */
export function copilotError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error
  const message = error instanceof Error ? error.message : String(error)
  const kind = ((): ProviderErrorKind => {
    if (/time(d)?[ -]?out/i.test(message)) return 'timeout'
    if (/\b(401|403)\b|unauthori[sz]ed|authenticat|forbidden|token/i.test(message)) return 'auth'
    if (/\b429\b|rate.?limit|quota/i.test(message)) return 'rate_limited'
    return 'provider_error'
  })()
  return new ProviderError(kind, `copilot: ${message}`, { cause: error })
}

/** What the session is created with: coral's tools only, in an empty directory. */
function sessionConfig(
  request: ChatRequest,
  token: string,
  workingDirectory: string,
): SessionConfig {
  const effort = request.options.effort
  const system = [request.system.stable, request.system.volatile].filter(Boolean).join('\n\n')
  return {
    model: request.model,
    ...(isEffort(effort) ? { reasoningEffort: effort } : {}),
    systemMessage: { mode: 'replace', content: system },
    tools: request.tools.map((spec) =>
      defineTool(spec.name, {
        description: spec.description,
        parameters: spec.inputSchema,
        skipPermission: true,
        handler: async (args: unknown) => {
          if (!request.callTool || request.toolChoice === 'none') {
            return JSON.stringify({ error: 'not_allowed' })
          }
          return (await request.callTool(spec.name, args)).result
        },
      }),
    ),
    // Built-in shell, file and web tools are off: only the tools coral declared.
    availableTools: request.tools.map((spec) => `custom:${spec.name}`),
    workingDirectory,
    infiniteSessions: { enabled: false },
    enableSessionStore: false,
    onPermissionRequest: () => DENY,
    gitHubTokenProvider: () => ({ kind: 'token', accessToken: token, expiresIn: TOKEN_SECONDS }),
  }
}

/**
 * The `copilot` adapter (`@github/copilot-sdk`, research R2, D47). Copilot is an agent: each call
 * is a fresh session that runs the tool loop itself through `request.callTool` (coral's limit of
 * rounds holds), sees images as blob attachments, and answers JSON held to `responseSchema`.
 * Usage sums the session's model calls; one premium request is counted per call (`per_request`).
 */
export function createCopilotAdapter(options: CopilotAdapterOptions): ProviderAdapter {
  return {
    id: 'copilot',
    vision: true,
    runsTools: true,
    async chat(request) {
      const schema = strictSchema(request.outputSchema)
      if (!schema) throw new ProviderError('bad_request', 'the answer schema cannot be sent')
      const workingDirectory = await mkdtemp(join(tmpdir(), 'coral-copilot-'))
      const usage: Required<Usage> = { input: 0, output: 0, cachedInput: 0, requests: 1 }
      let stop: ChatResponse['stop'] = 'end'
      let session: CopilotSessionLike | undefined
      try {
        const client = options.client ?? sdkClient(await sharedClient())
        session = await client.createSession(
          sessionConfig(request, options.token, workingDirectory),
        )
        const off = session.on('assistant.usage', ({ data }) => {
          const cached = data.cacheReadTokens ?? 0
          usage.input += Math.max(0, (data.inputTokens ?? 0) - cached)
          usage.cachedInput += cached
          usage.output += data.outputTokens ?? 0
          if (data.contentFilterTriggered) stop = 'refusal'
          else if (data.finishReason === 'length') stop = 'max_tokens'
        })
        const attachments = attachmentsOf(request.messages)
        const reply = await session.sendAndWait(
          {
            prompt: promptOf(request.messages),
            ...(attachments?.length ? { attachments } : {}),
            responseSchema: schema,
          },
          request.options.timeoutMs,
        )
        off()
        const text = reply?.data.content
        return { kind: 'final', ...(text ? { text } : {}), usage, stop }
      } catch (error) {
        throw copilotError(error)
      } finally {
        await session?.disconnect().catch(() => undefined)
        await rm(workingDirectory, { recursive: true, force: true })
      }
    },
  }
}
