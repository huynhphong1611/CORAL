import { describe, expect, it } from 'vitest'
import { ProviderError, type ChatRequest } from '../brain'
import { createGeminiAdapter } from './gemini'

// T022: the `gemini` adapter against a fake `fetch` — what generateContent is sent, how answers,
// usage and errors are read, and the two-phase mode for models that take no JSON mode together
// with function calling (research R2).

const MODEL = 'model-from-config'

interface Sent {
  url: string
  body: Record<string, unknown>
}

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

const answer = (parts: unknown[], finishReason = 'STOP', usage: object = {}) =>
  json({
    candidates: [{ content: { role: 'model', parts }, finishReason }],
    usageMetadata: {
      promptTokenCount: 1500,
      cachedContentTokenCount: 1000,
      candidatesTokenCount: 30,
      thoughtsTokenCount: 70,
      ...usage,
    },
  })

const apiError = (status: number, message: string) =>
  json({ error: { code: status, message, status: 'ERROR' } }, status)

const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: MODEL,
  system: { stable: 'You explore an Android app.', volatile: 'Steps left: 12' },
  messages: [
    {
      role: 'user',
      text: '#1 ImageView id="menuIV"',
      images: [{ mediaType: 'image/jpeg', data: 'AAAA' }],
    },
  ],
  tools: [
    {
      name: 'read_skill',
      description: 'Read a skill',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    },
  ],
  toolChoice: 'auto',
  outputSchema: {
    type: 'object',
    properties: { action: { type: 'string', const: 'back' }, reason: { type: 'string' } },
    required: ['action', 'reason'],
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
    gemini: createGeminiAdapter({ apiKey: 'g-test', fetch: fake.fetch, attempts: 1 }),
  }
}

describe('gemini adapter (T022)', () => {
  it('sends inline images, function declarations and the JSON schema in one call', async () => {
    const { gemini, sent } = adapter([answer([{ text: '{"action":"back","reason":"x"}' }])])
    const result = await gemini.chat(request())

    expect(sent[0]?.url).toContain(`models/${MODEL}:generateContent`)
    expect(sent[0]?.body).toMatchObject({
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } },
            { text: '#1 ImageView id="menuIV"' },
          ],
        },
      ],
      systemInstruction: {
        parts: [{ text: 'You explore an Android app.' }, { text: 'Steps left: 12' }],
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'read_skill',
              description: 'Read a skill',
              parametersJsonSchema: { type: 'object', properties: { name: { type: 'string' } } },
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: {
        responseMimeType: 'application/json',
        // Gemini knows no `const`: a one-value enum.
        responseJsonSchema: {
          type: 'object',
          properties: { action: { type: 'string', enum: ['back'] }, reason: { type: 'string' } },
          required: ['action', 'reason'],
          additionalProperties: false,
        },
        maxOutputTokens: 16000,
        thinkingConfig: { thinkingLevel: 'LOW' },
      },
    })
    expect(result).toMatchObject({
      kind: 'final',
      text: '{"action":"back","reason":"x"}',
      stop: 'end',
      // The prompt count holds the cached part; thinking is output.
      usage: { input: 500, cachedInput: 1000, output: 100 },
    })
  })

  it('reads function calls and sends the turn back with its thought signature', async () => {
    const turn = {
      role: 'model',
      parts: [
        { functionCall: { name: 'read_skill', args: { name: 'login' } }, thoughtSignature: 'sig' },
      ],
    }
    const { gemini, sent } = adapter([
      answer(turn.parts),
      answer([{ text: '{"action":"back","reason":"read"}' }]),
    ])
    const first = await gemini.chat(request())
    expect(first).toMatchObject({
      kind: 'tool_calls',
      stop: 'tool_use',
      toolCalls: [{ name: 'read_skill', args: { name: 'login' } }],
    })
    const call = first.toolCalls?.[0]
    if (!call) throw new Error('no call')

    await gemini.chat(
      request({
        messages: [
          ...request().messages,
          { role: 'assistant', toolCalls: [call], providerState: first.providerState },
          { role: 'tool', results: [{ id: call.id, name: call.name, content: '# Login' }] },
        ],
        toolChoice: 'none',
      }),
    )
    const body = sent[1]?.body ?? {}
    expect(body.contents).toEqual([
      expect.objectContaining({ role: 'user' }),
      turn,
      // Gemini gave the call no id: none goes back with the response.
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'read_skill', response: { output: '# Login' } } }],
      },
    ])
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } })
  })

  it('asks in two phases once a model refuses JSON mode with function calling', async () => {
    const refused = () =>
      apiError(400, 'Function calling with a response mime type: application/json is unsupported')
    const { gemini, sent } = adapter([
      refused(),
      // Phase 1: tools, no JSON — the model answers in prose; phase 2: JSON, no tools.
      answer([{ text: 'I would go back.' }]),
      answer([{ text: '{"action":"back","reason":"two phases"}' }]),
      // Next call of that model: straight to two phases.
      answer([{ functionCall: { id: 'c1', name: 'read_skill', args: {} } }]),
    ])
    const result = await gemini.chat(request())
    expect(result).toMatchObject({ kind: 'final', text: '{"action":"back","reason":"two phases"}' })
    expect(result.usage.output).toBe(200)
    const config = (i: number) => sent[i]?.body.generationConfig as Record<string, unknown>
    expect(sent[1]?.body).toHaveProperty('tools')
    expect(config(1)).not.toHaveProperty('responseMimeType')
    expect(sent[2]?.body).not.toHaveProperty('tools')
    expect(config(2)).toMatchObject({ responseMimeType: 'application/json' })

    const next = await gemini.chat(request())
    expect(next.toolCalls).toEqual([{ id: 'c1', name: 'read_skill', args: {} }])
    expect(sent).toHaveLength(4)
    expect(config(3)).not.toHaveProperty('responseMimeType')
  })

  it.each([
    ['SAFETY', 'refusal'],
    ['PROHIBITED_CONTENT', 'refusal'],
    ['MAX_TOKENS', 'max_tokens'],
  ])('maps finishReason %s to %s', async (reason, stop) => {
    const { gemini } = adapter([answer([{ text: '{' }], reason)])
    expect((await gemini.chat(request())).stop).toBe(stop)
  })

  it('reads a blocked prompt as a refusal', async () => {
    const { gemini } = adapter([json({ promptFeedback: { blockReason: 'SAFETY' } })])
    expect(await gemini.chat(request())).toMatchObject({ kind: 'final', stop: 'refusal' })
  })

  it.each([
    [apiError(429, 'quota'), 'rate_limited'],
    [apiError(403, 'API key not valid'), 'auth'],
    [apiError(400, 'bad schema'), 'bad_request'],
    [apiError(404, 'model not found'), 'provider_error'],
    [apiError(503, 'overloaded'), 'provider_error'],
    [new TypeError('fetch failed'), 'timeout'],
  ])('turns an error into ProviderError (%#)', async (failure, kind) => {
    const { gemini } = adapter([failure])
    const error: unknown = await gemini.chat(request()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).kind).toBe(kind)
  })
})
