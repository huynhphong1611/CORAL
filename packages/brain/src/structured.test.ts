import { describe, expect, it } from 'vitest'
import {
  BrainOutputError,
  EMPTY_KNOWLEDGE,
  NO_TOOLS,
  ProviderError,
  type ScreenInput,
  type ToolSet,
} from './brain'
import { decidePrompt, describePrompt } from './prompts'
import { MAX_TOOL_ROUNDS, checkAnswer, structuredChat, type AttemptRecord } from './structured'
import { final, scriptedAdapter, toolCall } from './testing/scripted'
import { screenSummarySchema } from '@coral/shared'

const screen: ScreenInput = {
  width: 1080,
  height: 2400,
  appPackage: 'com.saucelabs.mydemoapp.android',
  elements: [
    {
      n: 1,
      className: 'ImageView',
      id: 'menuIV',
      desc: 'View menu',
      bounds: [32, 154, 79, 79],
      flags: ['new'],
    },
  ],
  visibleTexts: [{ text: 'Products', height: 80 }],
}
const decide = decidePrompt(
  {
    screen,
    history: [],
    budget: { stepsLeft: 10, depth: 1, maxDepth: 8, costUsd: 0, maxCostUsd: 3 },
  },
  EMPTY_KNOWLEDGE,
)
const back = { action: 'back', reason: 'Nothing new here' }

function recorder() {
  const attempts: AttemptRecord[] = []
  return { attempts, onAttempt: (a: AttemptRecord) => void attempts.push(a) }
}

describe('structuredChat (research R3)', () => {
  it('re-asks once with the schema errors when the first answer is invalid', async () => {
    const adapter = scriptedAdapter([final({ action: 'tap', reason: 'no element' }), final(back)])
    const log = recorder()
    const { value, attempts } = await structuredChat({
      adapter,
      model: 'm',
      prompt: decide,
      tools: NO_TOOLS,
      onAttempt: log.onAttempt,
    })
    expect(value).toEqual(back)
    expect(adapter.requests).toHaveLength(2)
    expect(attempts.map((a) => [a.ok, a.error])).toEqual([
      [false, 'invalid_output'],
      [true, undefined],
    ])
    expect(log.attempts).toEqual(attempts)
    expect(attempts[0]?.validationErrors.join(' ')).toMatch(/element/)
    const reask = adapter.requests[1]?.messages.at(-1)
    expect(reask).toMatchObject({
      role: 'user',
      text: expect.stringMatching(/does not match/) as string,
    })
    // The JSON Schema comes from the Zod schema of the answer.
    expect(adapter.requests[0]?.outputSchema).toMatchObject({ oneOf: expect.any(Array) as unknown })
  })

  it('gives up after three invalid answers: no decision, three failed attempts', async () => {
    const adapter = scriptedAdapter([final('not json')])
    const log = recorder()
    await expect(
      structuredChat({
        adapter,
        model: 'm',
        prompt: decide,
        tools: NO_TOOLS,
        onAttempt: log.onAttempt,
      }),
    ).rejects.toBeInstanceOf(BrainOutputError)
    expect(adapter.requests).toHaveLength(3)
    expect(
      log.attempts.every((a) => a.error === 'invalid_output' && a.decision === undefined),
    ).toBe(true)
  })

  it('runs at most 5 tool rounds, then asks for the final answer without tools', async () => {
    const calls: string[] = []
    const tools: ToolSet = {
      specs: [{ name: 'otp__get_otp', description: 'OTP', inputSchema: { type: 'object' } }],
      call: (name) => {
        calls.push(name)
        return Promise.resolve({ result: '123456', ok: true })
      },
    }
    const adapter = scriptedAdapter([
      (request) => (request.toolChoice === 'auto' ? toolCall('otp__get_otp') : final(back)),
    ])
    const log = recorder()
    const { value } = await structuredChat({
      adapter,
      model: 'm',
      prompt: decide,
      tools,
      onAttempt: log.onAttempt,
    })
    expect(value).toEqual(back)
    expect(adapter.requests).toHaveLength(MAX_TOOL_ROUNDS + 1)
    // The tools stay declared; the last round may not call them.
    expect(adapter.requests.map((r) => r.tools.length)).toEqual([1, 1, 1, 1, 1, 1])
    expect(adapter.requests.map((r) => r.toolChoice)).toEqual([
      'auto',
      'auto',
      'auto',
      'auto',
      'auto',
      'none',
    ])
    expect(adapter.requests[5]?.messages.at(-1)).toMatchObject({
      role: 'user',
      text: expect.stringMatching(/final JSON/) as string,
    })
    expect(calls).toHaveLength(5)
    // One attempt holding the five rounds and the usage of all six calls.
    expect(log.attempts).toHaveLength(1)
    expect(log.attempts[0]?.rounds).toHaveLength(5)
    expect(log.attempts[0]?.usage).toEqual({ input: 600, output: 60, cachedInput: 0 })
  })

  it('sends tool results back and keeps blocked calls as errors for the AI', async () => {
    const tools: ToolSet = {
      specs: [{ name: 'otp__get_otp', description: '', inputSchema: {} }],
      call: (name) =>
        Promise.resolve(
          name === 'otp__delete_user'
            ? { result: '{"error":"not_allowed"}', ok: false, blocked: true, error: 'not_allowed' }
            : { result: 'x', ok: true },
        ),
    }
    const adapter = scriptedAdapter([toolCall('otp__delete_user'), final(back)])
    // The AI may name a tool it was not given: the tool set answers not_allowed.
    const { attempts } = await structuredChat({ adapter, model: 'm', prompt: decide, tools })
    expect(adapter.requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      results: [
        {
          id: 't-otp__delete_user',
          name: 'otp__delete_user',
          content: '{"error":"not_allowed"}',
          isError: true,
        },
      ],
    })
    expect(attempts[0]?.rounds[0]?.tool_calls[0]?.outcome).toMatchObject({ blocked: true })
  })

  it('reports a provider failure as a failed attempt and rethrows it', async () => {
    const adapter = scriptedAdapter([new ProviderError('rate_limited', '429')])
    const log = recorder()
    await expect(
      structuredChat({
        adapter,
        model: 'm',
        prompt: decide,
        tools: NO_TOOLS,
        onAttempt: log.onAttempt,
      }),
    ).rejects.toMatchObject({ kind: 'rate_limited' })
    expect(log.attempts).toMatchObject([{ ok: false, error: 'rate_limited', answer: null }])
  })

  it('treats a refusal or a cut answer as a provider failure', async () => {
    for (const stop of ['refusal', 'max_tokens'] as const) {
      const adapter = scriptedAdapter([{ ...final('{"name":'), stop }])
      await expect(
        structuredChat({
          adapter,
          model: 'm',
          prompt: describePrompt(screen, EMPTY_KNOWLEDGE),
          tools: NO_TOOLS,
        }),
      ).rejects.toMatchObject({ kind: stop === 'refusal' ? 'refusal' : 'provider_error' })
    }
  })
})

describe('checkAnswer', () => {
  it('accepts JSON in a Markdown fence and reports schema errors by path', () => {
    expect(
      checkAnswer(screenSummarySchema, '```json\n{"name":"Catalog","purpose":"List"}\n```'),
    ).toEqual({
      ok: true,
      value: { name: 'Catalog', purpose: 'List' },
    })
    expect(checkAnswer(screenSummarySchema, '{"name":""}')).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/^name:/), expect.stringMatching(/^purpose:/)],
    })
    expect(checkAnswer(screenSummarySchema, '')).toEqual({ ok: false, errors: ['empty answer'] })
  })
})
