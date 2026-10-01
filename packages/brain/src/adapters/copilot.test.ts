import { existsSync } from 'node:fs'
import type { MessageOptions, SessionConfig } from '@github/copilot-sdk'
import { actionDecisionSchema } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { ProviderError, type ChatRequest, type ToolSet } from '../brain'
import { costOf } from '../router'
import { MAX_TOOL_ROUNDS, structuredChat } from '../structured'
import { copilotError, createCopilotAdapter, type CopilotUsageEvent } from './copilot'

// T026: the `copilot` adapter against a fake SDK client — the session it creates (coral's
// tools only, an empty directory, the tenant's token), images as blobs, the agent's tool calls
// going through coral's ToolSet within the limit of rounds, usage and errors (D47).

interface Script {
  /** Tool calls the agent makes, in order, before answering. */
  calls?: { name: string; args: unknown }[]
  answer?: string
  usage?: CopilotUsageEvent['data'][]
  failOn?: 'create' | 'send'
  error?: string
}

function fakeClient(script: Script) {
  const seen: {
    config?: SessionConfig
    message?: MessageOptions
    timeout?: number
    toolResults: string[]
    workdirDuringCall?: boolean
    disconnected: boolean
  } = { toolResults: [], disconnected: false }
  const client = {
    createSession: (config: SessionConfig) => {
      seen.config = config
      if (script.failOn === 'create') return Promise.reject(new Error(script.error))
      const listeners: ((event: CopilotUsageEvent) => void)[] = []
      return Promise.resolve({
        on: (_: 'assistant.usage', handler: (event: CopilotUsageEvent) => void) => {
          listeners.push(handler)
          return () => listeners.splice(listeners.indexOf(handler), 1)
        },
        sendAndWait: async (message: MessageOptions, timeout?: number) => {
          seen.message = message
          seen.timeout = timeout
          seen.workdirDuringCall = existsSync(config.workingDirectory ?? '/nowhere')
          if (script.failOn === 'send') throw new Error(script.error)
          for (const call of script.calls ?? []) {
            const tool = config.tools?.find((t) => t.name === call.name)
            const result: unknown = await tool?.handler?.(call.args, {} as never)
            seen.toolResults.push(String(result))
          }
          for (const data of script.usage ?? []) for (const l of listeners) l({ data })
          return { data: { content: script.answer ?? '' } }
        },
        disconnect: () => {
          seen.disconnected = true
          return Promise.resolve()
        },
      })
    },
  }
  return { client, seen }
}

const back = { action: 'back', reason: 'Nothing new here' }

const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'model-from-config',
  system: { stable: 'You explore an Android app.', volatile: 'Steps left: 12' },
  messages: [
    { role: 'user', text: '#1 ImageView', images: [{ mediaType: 'image/jpeg', data: 'AAAA' }] },
  ],
  tools: [
    {
      name: 'read_skill',
      description: 'Read a skill',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  ],
  toolChoice: 'auto',
  outputSchema: {
    type: 'object',
    properties: { reason: { type: 'string', maxLength: 300 } },
    additionalProperties: false,
  },
  options: { effort: 'medium', timeoutMs: 5000 },
  task: { kind: 'write_test', input: { kind: 'explore', maxTests: 1, steps: [] } },
  ...over,
})

describe('copilot adapter (T026)', () => {
  it('opens a session with coral tools only, the tenant token and an empty directory', async () => {
    const { client, seen } = fakeClient({
      answer: '{"reason":"ok"}',
      usage: [
        { inputTokens: 1200, cacheReadTokens: 800, outputTokens: 40 },
        { inputTokens: 300, outputTokens: 10 },
      ],
    })
    const copilot = createCopilotAdapter({ token: 'ghu_tenant', client })
    expect(copilot).toMatchObject({ id: 'copilot', vision: true, runsTools: true })
    const answer = await copilot.chat(request())

    const config = seen.config
    expect(config).toMatchObject({
      model: 'model-from-config',
      reasoningEffort: 'medium',
      systemMessage: { mode: 'replace', content: 'You explore an Android app.\n\nSteps left: 12' },
      availableTools: ['custom:read_skill'],
      infiniteSessions: { enabled: false },
      enableSessionStore: false,
    })
    expect(config?.tools?.map((t) => [t.name, t.skipPermission])).toEqual([['read_skill', true]])
    // Anything else the agent may try (shell, files) is refused.
    expect(await config?.onPermissionRequest?.({} as never, { sessionId: 's' })).toEqual({
      kind: 'denied-interactively-by-user',
    })
    expect(await config?.gitHubTokenProvider?.({} as never)).toMatchObject({
      kind: 'token',
      accessToken: 'ghu_tenant',
    })
    // The empty directory existed during the call and is gone after it.
    expect(seen.workdirDuringCall).toBe(true)
    expect(existsSync(config?.workingDirectory ?? '')).toBe(false)
    expect(seen.disconnected).toBe(true)

    expect(seen.message).toMatchObject({
      prompt: '#1 ImageView',
      attachments: [{ type: 'blob', data: 'AAAA', mimeType: 'image/jpeg' }],
      responseSchema: {
        type: 'object',
        properties: { reason: { type: 'string', description: '{maxLength: 300}' } },
      },
    })
    expect(seen.timeout).toBe(5000)
    expect(answer).toEqual({
      kind: 'final',
      text: '{"reason":"ok"}',
      stop: 'end',
      // Every model call of the session; one premium request.
      usage: { input: 700, cachedInput: 800, output: 50, requests: 1 },
    })
  })

  it('runs the agent tool calls through ToolSet within the limit of rounds', async () => {
    const ran: unknown[] = []
    const tools: ToolSet = {
      specs: request().tools,
      call: (_, args) => {
        ran.push(args)
        return Promise.resolve({ result: '# Login skill', ok: true })
      },
    }
    const calls = Array.from({ length: MAX_TOOL_ROUNDS + 2 }, (_, i) => ({
      name: 'read_skill',
      args: { name: `skill-${i}` },
    }))
    const { client, seen } = fakeClient({ calls, answer: JSON.stringify(back) })
    const { value, attempts } = await structuredChat({
      adapter: createCopilotAdapter({ token: 't', client }),
      model: 'model-from-config',
      prompt: {
        system: { stable: 's', volatile: '' },
        messages: [{ role: 'user', text: 'decide' }],
        schema: actionDecisionSchema,
        task: request().task,
      },
      tools,
    })
    expect(value).toEqual(back)
    expect(ran).toHaveLength(MAX_TOOL_ROUNDS)
    expect(seen.toolResults.slice(0, MAX_TOOL_ROUNDS)).toEqual(
      Array.from({ length: MAX_TOOL_ROUNDS }, () => '# Login skill'),
    )
    // Past the limit, the agent is told to answer now.
    expect(seen.toolResults.slice(MAX_TOOL_ROUNDS).map((r) => JSON.parse(r) as unknown)).toEqual([
      expect.objectContaining({ error: 'tool_limit' }),
      expect.objectContaining({ error: 'tool_limit' }),
    ])
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.rounds).toHaveLength(MAX_TOOL_ROUNDS)
  })

  it('writes an earlier exchange out before the last message (a re-ask)', async () => {
    const { client, seen } = fakeClient({ answer: '{"reason":"ok"}' })
    await createCopilotAdapter({ token: 't', client }).chat(
      request({
        messages: [
          { role: 'user', text: 'Decide.' },
          { role: 'assistant', text: '{"reason":' },
          { role: 'user', text: 'Your answer is not valid JSON. Answer again.' },
        ],
      }),
    )
    expect(seen.message?.prompt).toBe(
      'Conversation so far:\n\nUser: Decide.\n\nYou answered: {"reason":\n\n' +
        'Your answer is not valid JSON. Answer again.',
    )
    expect(seen.message).not.toHaveProperty('attachments')
  })

  it('reads a content filter as a refusal', async () => {
    const { client } = fakeClient({ usage: [{ contentFilterTriggered: true }] })
    const answer = await createCopilotAdapter({ token: 't', client }).chat(request())
    expect(answer.stop).toBe('refusal')
  })

  it.each([
    ['create', 'Unauthorized: bad credentials', 'auth'],
    ['send', 'Timeout after 5000ms waiting for session.idle', 'timeout'],
    ['send', 'HTTP 429: rate limit exceeded', 'rate_limited'],
    ['send', 'runtime exited', 'provider_error'],
  ] as const)('turns a %s failure into ProviderError (%s)', async (failOn, error, kind) => {
    const { client, seen } = fakeClient({ failOn, error })
    const thrown: unknown = await createCopilotAdapter({ token: 't', client })
      .chat(request())
      .catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(ProviderError)
    expect((thrown as ProviderError).kind).toBe(kind)
    expect(existsSync(seen.config?.workingDirectory ?? '')).toBe(false)
    expect(copilotError(thrown)).toBe(thrown)
  })

  it('counts one premium request at the per_request price', () => {
    const usage = { input: 1000, output: 100, cachedInput: 0, requests: 1 }
    expect(costOf(usage, { input: 0, output: 0, per_request: 0.04 })).toBeCloseTo(0.04)
    expect(costOf(usage, { input: 1, output: 2, per_request: 0.04 })).toBeCloseTo(0.0412)
  })
})
