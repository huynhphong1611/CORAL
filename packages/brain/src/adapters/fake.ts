import type { ActionDecision, Flow, ScreenSummary, TestPlan } from '@coral/shared'
import type {
  ChatRequest,
  ChatResponse,
  ChatTask,
  DecideInput,
  ProviderAdapter,
  ScreenElement,
  ScreenInput,
  ToolSpec,
  WriteTestInput,
} from '../brain'

/**
 * A scripted provider for unit, integration, E2E and Device tests: no network, no cost, the same
 * answer for the same input (research R2). Accepted only when the server runs with
 * `CORAL_BRAIN_FAKE=1`. `fake` and `fake-alt` are two names of it, to test switching provider.
 */
export interface FakeScript {
  /** Tool calls to make on a round of a task (1-based); none → answer. */
  tools?: (
    task: ChatTask,
    round: number,
    offered: readonly ToolSpec[],
  ) => { name: string; args: unknown }[] | undefined
}

/** A quoted text in the goal is what the fake waits for on screen (`… until "Cart (1)"`). */
export function goalTarget(goal: string | undefined): string | undefined {
  if (!goal) return undefined
  return /"([^"]+)"|“([^”]+)”/u
    .exec(goal)
    ?.slice(1)
    .find((g) => g !== undefined)
}

export function fakeDescribe(screen: ScreenInput): ScreenSummary {
  const largest = [...screen.visibleTexts]
    .filter((t) => t.text.trim() !== '')
    .sort((a, b) => b.height - a.height)[0]
  const fallback = screen.knownAs ?? screen.elements.find((e) => e.text ?? e.desc)?.text ?? 'Screen'
  const name = (largest?.text ?? fallback).trim().slice(0, 60) || 'Screen'
  return { name, purpose: `Screen with ${screen.elements.length} usable element(s)` }
}

const reason = (text: string) => text.slice(0, 300)
const lower = (s: string | undefined) => (s ?? '').toLowerCase()

function fieldValue(
  element: ScreenElement,
  knowledge: { testData: { name: string; value?: string; secret?: string }[] },
  toolResult: string | undefined,
): ActionDecision {
  const base = { action: 'type' as const, element: element.n }
  if (toolResult !== undefined) {
    return { ...base, text: toolResult.trim().slice(0, 64) || 'x', reason: 'Value from a tool' }
  }
  if (element.flags.includes('password')) {
    const secret = knowledge.testData.find((d) => d.secret !== undefined)?.secret
    if (secret) return { ...base, secret, reason: 'Password from the project test data' }
  } else {
    const data = knowledge.testData.find((d) => d.value !== undefined)
    if (data && !element.flags.includes('search')) {
      return { ...base, test_data: data.name, reason: 'Named test data of the project' }
    }
  }
  return {
    ...base,
    text: element.flags.includes('search') ? 'a' : 'coral',
    reason: 'Made-up value',
  }
}

export function fakeDecide(
  input: DecideInput,
  knowledge: { testData: { name: string; value?: string; secret?: string }[] } = { testData: [] },
  toolResult?: string,
): ActionDecision {
  const { screen } = input
  const target = goalTarget(input.goal)
  if (target) {
    const seen = [
      ...screen.visibleTexts.map((t) => t.text),
      ...screen.elements.map((e) => e.text ?? ''),
    ]
    if (seen.some((t) => lower(t).includes(lower(target)))) {
      return { action: 'done', goal_reached: true, reason: reason(`"${target}" is on the screen`) }
    }
  }
  if (input.onlyBack) return { action: 'back', reason: 'Maximum depth reached' }
  const next = screen.elements.find((e) => e.flags.includes('new') && !e.flags.includes('dead'))
  if (!next) return { action: 'back', reason: 'Nothing new on this screen' }
  if (next.flags.includes('field')) return fieldValue(next, knowledge, toolResult)
  if (next.flags.includes('scroll')) {
    return { action: 'swipe', element: next.n, direction: 'up', reason: 'See more of the list' }
  }
  const label = next.text ?? next.desc ?? next.id ?? `#${next.n}`
  return { action: 'tap', element: next.n, reason: reason(`Try "${label}", not tried yet`) }
}

/** One flow per segment: from its start to its last done step, the Recorder's first suggestion. */
export function fakeWrite(input: WriteTestInput): TestPlan {
  const done = input.steps.filter((s) => s.status === 'done')
  if (done.length === 0) {
    return input.kind === 'import'
      ? { flows: [], outcome: 'app_mismatch', explanation: 'No step could be done on the app' }
      : { flows: [], outcome: 'written' }
  }
  const segments = [...new Set(done.map((s) => s.segment))]
  const wanted = input.kind === 'explore' ? segments : segments.slice(-1)
  const flows: Flow[] = wanted.slice(0, input.maxTests).map((segment) => {
    const steps = done.filter((s) => s.segment === segment)
    const last = steps[steps.length - 1] ?? done[0]
    const withCandidate = [...steps].reverse().find((s) => s.candidates.length > 0)
    const withText = [...steps].reverse().find((s) => s.textsAfter.length > 0)
    const expects = withCandidate
      ? [{ step: withCandidate.n, candidate: 0 }]
      : withText
        ? [{ step: withText.n, visible_text: withText.textsAfter[0] ?? '' }]
        : []
    const first = steps[0]
    const name = input.manualCase?.title ?? input.goal ?? `Flow from ${first?.screen ?? 'start'}`
    return {
      slug: `flow-${segment}`,
      name: name.slice(0, 80),
      intent: (
        input.goal ?? `From "${first?.screen ?? 'start'}", ${steps.map((s) => s.action).join(', ')}`
      ).slice(0, 300),
      segment,
      end_step: last?.n ?? 1,
      expects,
    }
  })
  return { flows, outcome: 'written' }
}

const tokens = (text: string) => Math.ceil(text.length / 4)

export function createFakeAdapter(
  id: 'fake' | 'fake-alt' = 'fake',
  script: FakeScript = {},
): ProviderAdapter {
  return {
    id,
    vision: true,
    chat(request: ChatRequest): Promise<ChatResponse> {
      const sent = JSON.stringify(request.messages).length + request.system.stable.length
      const toolMessages = request.messages.filter((m) => m.role === 'tool')
      const round = toolMessages.length + 1
      if (request.tools.length > 0) {
        const calls = script.tools?.(request.task, round, request.tools)
        if (calls && calls.length > 0) {
          return Promise.resolve({
            kind: 'tool_calls',
            toolCalls: calls.map((c, i) => ({ id: `call-${round}-${i}`, ...c })),
            usage: { input: Math.ceil(sent / 4), output: 20, cachedInput: 0 },
            stop: 'tool_use',
          })
        }
      }
      const lastTool = toolMessages.at(-1)
      const toolResult =
        lastTool?.role === 'tool' && request.messages.at(-1)?.role === 'tool'
          ? lastTool.results.find((r) => !r.isError)?.content
          : undefined
      const answer = answerOf(request, toolResult)
      const text = JSON.stringify(answer)
      return Promise.resolve({
        kind: 'final',
        text,
        usage: { input: Math.ceil(sent / 4), output: tokens(text), cachedInput: 0 },
        stop: 'end',
      })
    },
  }
}

function answerOf(request: ChatRequest, toolResult: string | undefined): unknown {
  const { task } = request
  switch (task.kind) {
    case 'describe_screen':
      return fakeDescribe(task.input)
    case 'next_action':
      return fakeDecide(task.input, testDataOf(request.system.stable), toolResult)
    case 'write_test':
      return fakeWrite(task.input)
  }
}

/** The fake reads named test data back from the stable prompt (`- NAME: secret X` / `- NAME: "v"`). */
function testDataOf(stable: string): {
  testData: { name: string; value?: string; secret?: string }[]
} {
  const section = /## Test data\n([\s\S]*?)(?:\n## |$)/.exec(stable)?.[1] ?? ''
  const testData = section
    .split('\n')
    .map((line) =>
      /^- ([A-Za-z_][A-Za-z0-9_]*): (?:secret ([A-Za-z_][A-Za-z0-9_]*)|(".*"))/.exec(line),
    )
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) =>
      m[2] !== undefined
        ? { name: m[1] ?? '', secret: m[2] }
        : { name: m[1] ?? '', value: JSON.parse(m[3] ?? '""') as string },
    )
  return { testData }
}
