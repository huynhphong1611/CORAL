import { describe, expect, it } from 'vitest'
import { ProviderError, type ChatRequest } from '../brain'
import { createClaudeAdapter } from './claude'

// T021: the `claude` adapter against a fake `fetch` — the body it sends and how it reads
// answers and errors (research R2). The model name comes from the request (the brains config).

const MODEL = 'model-from-config'

interface Sent {
  url: string
  body: Record<string, unknown>
}

/** A fetch answering each call with the next of `answers`; what was sent is kept. */
function fakeFetch(answers: (Response | Error)[]) {
  const sent: Sent[] = []
  const fn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = typeof init?.body === 'string' ? init.body : '{}'
    sent.push({ url, body: JSON.parse(body) as Record<string, unknown> })
    const answer = answers.shift()
    if (!answer) throw new Error('no answer left')
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
  }
  return { fetch: fn, sent }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const message = (content: unknown[], stop_reason = 'end_turn', usage: object = {}) =>
  json({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: 1200,
      output_tokens: 40,
      cache_read_input_tokens: 3000,
      cache_creation_input_tokens: 500,
      ...usage,
    },
  })

const apiError = (status: number, type: string) =>
  json({ type: 'error', error: { type, message: `${type} happened` } }, status)

const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: MODEL,
  system: { stable: 'You explore an Android app.', volatile: 'Steps left: 12' },
  messages: [
    {
      role: 'user',
      text: '#1 ImageView id="menuIV" desc="View menu"',
      images: [{ mediaType: 'image/jpeg', data: 'AAAA', ref: 'explorations/x/1/ai.jpg' }],
    },
  ],
  tools: [
    {
      name: 'read_skill',
      description: 'Read a skill',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', enum: ['login'] } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  ],
  toolChoice: 'auto',
  outputSchema: {
    type: 'object',
    properties: { reason: { type: 'string', minLength: 1, maxLength: 300 } },
    required: ['reason'],
    additionalProperties: false,
  },
  options: { effort: 'low', timeoutMs: 5000 },
  task: { kind: 'write_test', input: { kind: 'explore', maxTests: 1, steps: [] } },
  ...over,
})

const adapter = (answers: (Response | Error)[]) => {
  const fake = fakeFetch(answers)
  return {
    ...fake,
    claude: createClaudeAdapter({ apiKey: 'sk-test', fetch: fake.fetch, maxRetries: 0 }),
  }
}

describe('claude adapter (T021)', () => {
  it('sends images, cached system, strict tools and the JSON answer schema', async () => {
    const { claude, sent } = adapter([
      message([{ type: 'text', text: '{"reason":"ok"}' }], 'end_turn'),
    ])
    const answer = await claude.chat(request())

    expect(sent[0]?.url).toMatch(/\/v1\/messages$/)
    const body = sent[0]?.body ?? {}
    expect(body).toMatchObject({
      model: MODEL,
      max_tokens: 16000,
      system: [
        {
          type: 'text',
          text: 'You explore an Android app.',
          cache_control: { type: 'ephemeral' },
        },
        { type: 'text', text: 'Steps left: 12' },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
            { type: 'text', text: '#1 ImageView id="menuIV" desc="View menu"' },
          ],
        },
      ],
      tools: [
        {
          name: 'read_skill',
          strict: true,
          input_schema: {
            type: 'object',
            properties: { name: { type: 'string', enum: ['login'] } },
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: 'auto' },
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              reason: { type: 'string', description: '{minLength: 1, maxLength: 300}' },
            },
            additionalProperties: false,
          },
        },
      },
    })
    // No sampling parameters: current models refuse them.
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('thinking')

    expect(answer).toMatchObject({
      kind: 'final',
      text: '{"reason":"ok"}',
      stop: 'end',
      // Cache writes count as input; cache reads apart, at the cached price.
      usage: { input: 1700, output: 40, cachedInput: 3000 },
    })
  })

  it('reads tool calls, then sends the turn back as it came with the results', async () => {
    const turn = [
      { type: 'thinking', thinking: '', signature: 'sig-1' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_skill', input: { name: 'login' } },
    ]
    const { claude, sent } = adapter([
      message(turn, 'tool_use'),
      message([{ type: 'text', text: '{"reason":"done"}' }]),
    ])
    const first = await claude.chat(request())
    expect(first).toMatchObject({
      kind: 'tool_calls',
      stop: 'tool_use',
      toolCalls: [{ id: 'toolu_1', name: 'read_skill', args: { name: 'login' } }],
    })

    await claude.chat(
      request({
        messages: [
          ...request().messages,
          {
            role: 'assistant',
            toolCalls: first.toolCalls ?? [],
            providerState: first.providerState,
          },
          {
            role: 'tool',
            results: [{ id: 'toolu_1', name: 'read_skill', content: '# Login', isError: true }],
          },
          { role: 'user', text: 'Answer now.' },
        ],
        toolChoice: 'none',
      }),
    )
    const body = sent[1]?.body ?? {}
    expect(body.messages).toEqual([
      expect.objectContaining({ role: 'user' }),
      // The thinking block goes back unchanged with its signature.
      { role: 'assistant', content: turn },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '# Login', is_error: true },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'Answer now.' }] },
    ])
    // The final round keeps the tools declared but may not call them.
    expect(body.tool_choice).toEqual({ type: 'none' })
    expect(body.tools).toHaveLength(1)
  })

  it('builds an assistant turn of another conversation from its text and tool calls', async () => {
    const { claude, sent } = adapter([message([{ type: 'text', text: '{"reason":"x"}' }])])
    await claude.chat(
      request({
        tools: [],
        messages: [
          { role: 'user', text: 'Q' },
          {
            role: 'assistant',
            text: 'Let me read it.',
            toolCalls: [{ id: 't1', name: 'otp__get', args: {} }],
          },
          { role: 'tool', results: [{ id: 't1', name: 'otp__get', content: '123456' }] },
        ],
      }),
    )
    const body = sent[0]?.body ?? {}
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Q' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me read it.' },
          { type: 'tool_use', id: 't1', name: 'otp__get', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '123456' }] },
    ])
    // No tools: neither tools nor tool_choice is sent.
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('tool_choice')
  })

  it('declares a tool whose schema cannot be strict as it is, without strict', async () => {
    const { claude, sent } = adapter([message([{ type: 'text', text: '{"reason":"x"}' }])])
    const loose = { type: 'object', properties: { query: {} } }
    await claude.chat(
      request({ tools: [{ name: 'db__query', description: 'Query', inputSchema: loose }] }),
    )
    expect(sent[0]?.body.tools).toEqual([
      { name: 'db__query', description: 'Query', input_schema: loose },
    ])
  })

  it.each([
    ['refusal', 'refusal'],
    ['max_tokens', 'max_tokens'],
    ['model_context_window_exceeded', 'max_tokens'],
    ['stop_sequence', 'end'],
  ])('maps stop_reason %s to %s', async (reason, stop) => {
    const { claude } = adapter([message([{ type: 'text', text: '{' }], reason)])
    expect((await claude.chat(request())).stop).toBe(stop)
  })

  it.each([
    [apiError(429, 'rate_limit_error'), 'rate_limited'],
    [apiError(401, 'authentication_error'), 'auth'],
    [apiError(403, 'permission_error'), 'auth'],
    [apiError(402, 'billing_error'), 'auth'],
    [apiError(400, 'invalid_request_error'), 'bad_request'],
    [apiError(404, 'not_found_error'), 'provider_error'],
    [apiError(500, 'api_error'), 'provider_error'],
    [apiError(529, 'overloaded_error'), 'provider_error'],
    [new TypeError('fetch failed'), 'timeout'],
  ])('turns an error into ProviderError (%#)', async (answer, kind) => {
    const { claude } = adapter([answer])
    const error: unknown = await claude.chat(request()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).kind).toBe(kind)
  })
})
