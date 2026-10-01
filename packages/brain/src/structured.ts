import type { z } from 'zod'
import {
  BrainOutputError,
  ProviderError,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
  type ProviderErrorKind,
  type ToolCall,
  type ToolOutcome,
  type ToolSet,
  type Usage,
} from './brain'
import { outputSchemaOf, type Prompt } from './prompts'

/** Re-asks after an answer that breaks its schema (research R3). */
export const MAX_REASKS = 2
/** Tool rounds per decision; the next round must answer without tools (FR-017). */
export const MAX_TOOL_ROUNDS = 5
export const DEFAULT_TIMEOUT_MS = 60_000
/** A shortened list of schema errors sent back with a re-ask. */
const MAX_ERROR_TEXT = 1000

const FINAL_ROUND_NOTE =
  'You used all tool rounds. Answer now with the final JSON object only, without tools.'

export interface ToolRound {
  tool_calls: { name: string; args: unknown; result: string; outcome: ToolOutcome }[]
}

/**
 * One attempt: the exchange that ends with an answer (its tool rounds included). A re-ask is a
 * new attempt; so is each provider the router falls back to. One `brain_calls` row each (D41).
 */
export interface AttemptRecord {
  provider: ProviderAdapter['id']
  model: string
  usage: Usage
  latencyMs: number
  ok: boolean
  /** Why the attempt failed; `invalid_output` when its answer broke the schema. */
  error?: ProviderErrorKind | 'invalid_output'
  system: { stable: string; volatile: string }
  /** The conversation as sent on the attempt's last round. */
  messages: ChatMessage[]
  rounds: ToolRound[]
  answer: string | null
  validationErrors: string[]
  decision?: unknown
}

export interface StructuredOptions<T> {
  adapter: ProviderAdapter
  model: string
  effort?: string
  prompt: Prompt<T>
  tools: ToolSet
  timeoutMs?: number
  /** Called once per attempt, failed ones included, before the next one starts. */
  onAttempt?: (attempt: AttemptRecord) => Promise<void> | void
}

const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cachedInput: a.cachedInput + b.cachedInput,
})
const NO_USAGE: Usage = { input: 0, output: 0, cachedInput: 0 }

/** `path: message; …`, short enough to send back with a re-ask. */
export function summarizeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.')
    return path ? `${path}: ${issue.message}` : issue.message
  })
}

/** Parses and checks an answer; the errors are what the AI is told on a re-ask. */
export function checkAnswer<T>(
  schema: z.ZodType<T>,
  text: string | undefined,
): { ok: true; value: T } | { ok: false; errors: string[] } {
  if (text === undefined || text.trim() === '') return { ok: false, errors: ['empty answer'] }
  let json: unknown
  try {
    json = JSON.parse(stripFence(text))
  } catch {
    return { ok: false, errors: ['the answer is not valid JSON'] }
  }
  const parsed = schema.safeParse(json)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: summarizeIssues(parsed.error) }
}

/** Some models wrap JSON in a Markdown fence even when asked not to. */
function stripFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text)
  return fenced?.[1] ?? text
}

function reaskText(errors: string[]): string {
  const list = errors.join('; ').slice(0, MAX_ERROR_TEXT)
  return `Your answer does not match the required JSON schema: ${list}. Answer again with only the corrected JSON object.`
}

/**
 * Asks one provider for a structured answer (research R3): tool rounds up to MAX_TOOL_ROUNDS,
 * then the final answer checked with Zod, re-asked up to MAX_REASKS times with the errors.
 * Throws `ProviderError` when the provider fails and `BrainOutputError` when the answer stays
 * invalid; every attempt is reported to `onAttempt` either way.
 */
export async function structuredChat<T>(
  options: StructuredOptions<T>,
): Promise<{ value: T; attempts: AttemptRecord[] }> {
  const { adapter, prompt, tools } = options
  const outputSchema = outputSchemaOf(prompt.schema)
  const messages: ChatMessage[] = [...prompt.messages]
  const attempts: AttemptRecord[] = []
  let toolRounds = 0
  let finalNoteSent = false

  const report = async (attempt: AttemptRecord) => {
    attempts.push(attempt)
    await options.onAttempt?.(attempt)
  }

  for (let reask = 0; reask <= MAX_REASKS; reask += 1) {
    const started = Date.now()
    let usage = NO_USAGE
    const rounds: ToolRound[] = []
    const base = () => ({
      provider: adapter.id,
      model: options.model,
      usage,
      latencyMs: Date.now() - started,
      system: prompt.system,
      messages: [...messages],
      rounds,
    })

    let response: ChatResponse
    for (;;) {
      const finalRound = toolRounds >= MAX_TOOL_ROUNDS
      if (finalRound && !finalNoteSent) {
        messages.push({ role: 'user', text: FINAL_ROUND_NOTE })
        finalNoteSent = true
      }
      const request: ChatRequest = {
        model: options.model,
        system: prompt.system,
        messages: [...messages],
        tools: finalRound ? [] : tools.specs,
        outputSchema,
        options: {
          ...(options.effort ? { effort: options.effort } : {}),
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        },
        task: prompt.task,
      }
      try {
        response = await adapter.chat(request)
      } catch (error) {
        const failure =
          error instanceof ProviderError
            ? error
            : new ProviderError(
                'provider_error',
                error instanceof Error ? error.message : String(error),
                {
                  cause: error,
                },
              )
        await report({
          ...base(),
          ok: false,
          error: failure.kind,
          answer: null,
          validationErrors: [],
        })
        throw failure
      }
      usage = addUsage(usage, response.usage)

      if (response.stop === 'refusal' || response.stop === 'max_tokens') {
        const kind: ProviderErrorKind = response.stop === 'refusal' ? 'refusal' : 'provider_error'
        await report({
          ...base(),
          ok: false,
          error: kind,
          answer: response.text ?? null,
          validationErrors: [],
        })
        throw new ProviderError(kind, `the provider stopped with ${response.stop}`)
      }
      if (response.kind !== 'tool_calls' || !response.toolCalls?.length || finalRound) break

      toolRounds += 1
      const calls: ToolCall[] = response.toolCalls
      const round: ToolRound = { tool_calls: [] }
      const results: { id: string; name: string; content: string; isError?: boolean }[] = []
      for (const call of calls) {
        const outcome = await tools.call(call.name, call.args)
        round.tool_calls.push({ name: call.name, args: call.args, result: outcome.result, outcome })
        results.push({
          id: call.id,
          name: call.name,
          content: outcome.result,
          ...(outcome.ok ? {} : { isError: true }),
        })
      }
      rounds.push(round)
      messages.push({
        role: 'assistant',
        ...(response.text ? { text: response.text } : {}),
        toolCalls: calls,
      })
      messages.push({ role: 'tool', results })
    }

    const checked = checkAnswer(prompt.schema, response.text)
    if (checked.ok) {
      await report({
        ...base(),
        ok: true,
        answer: response.text ?? null,
        validationErrors: [],
        decision: checked.value,
      })
      return { value: checked.value, attempts }
    }
    await report({
      ...base(),
      ok: false,
      error: 'invalid_output',
      answer: response.text ?? null,
      validationErrors: checked.errors,
    })
    if (reask === MAX_REASKS) {
      throw new BrainOutputError(
        `the answer broke its schema ${MAX_REASKS + 1} times`,
        checked.errors,
      )
    }
    messages.push({ role: 'assistant', text: response.text ?? '' })
    messages.push({ role: 'user', text: reaskText(checked.errors) })
  }
  throw new Error('unreachable')
}
