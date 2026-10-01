import type { ChatRequest, ChatResponse, ProviderAdapter } from '../brain'
import { ProviderError } from '../brain'

type Step =
  Partial<ChatResponse> | ProviderError | ((request: ChatRequest) => Partial<ChatResponse>)

/** An adapter that answers from a list, one entry per call, and keeps every request. */
export function scriptedAdapter(
  steps: Step[],
  id: ProviderAdapter['id'] = 'fake',
): ProviderAdapter & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  return {
    id,
    vision: true,
    requests,
    chat(request) {
      requests.push(request)
      const step = steps[Math.min(requests.length - 1, steps.length - 1)]
      if (step instanceof ProviderError) return Promise.reject(step)
      const partial = typeof step === 'function' ? step(request) : (step ?? {})
      return Promise.resolve({
        kind: 'final',
        stop: 'end',
        usage: { input: 100, output: 10, cachedInput: 0 },
        ...partial,
      })
    },
  }
}

export const final = (answer: unknown): Partial<ChatResponse> => ({
  kind: 'final',
  text: typeof answer === 'string' ? answer : JSON.stringify(answer),
})

export const toolCall = (name: string, args: unknown = {}): Partial<ChatResponse> => ({
  kind: 'tool_calls',
  stop: 'tool_use',
  toolCalls: [{ id: `t-${name}`, name, args }],
})
