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
const isInjection = (t: { text: string }) =>
  /ignore (all |any )?previous instructions/i.test(t.text)
const lower = (s: string | undefined) => (s ?? '').toLowerCase()

/** Parts of a field's id, text and description (`nameET` → name), noise words left out. */
function fieldWords(element: ScreenElement): string[] {
  return [element.id, element.text, element.desc]
    .join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !['edit', 'text', 'input', 'field', 'view'].includes(w))
}

/** The named test data meant for this field: `username` for a field `nameET` / "User name". */
function dataFor(
  element: ScreenElement,
  testData: readonly { name: string; value?: string; secret?: string }[],
) {
  const words = fieldWords(element)
  return testData.find((d) => {
    const name = d.name.toLowerCase().replace(/[^a-z0-9]/g, '')
    return words.some((w) => name.includes(w) || w.includes(name))
  })
}

/** Secrets a goal names (`${secret:TEST_USER}`): an imported case says what to type (US6). */
function goalSecrets(goal: string | undefined): string[] {
  return [...(goal ?? '').matchAll(/\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}/g)].flatMap((m) =>
    m[1] ? [m[1]] : [],
  )
}

function fieldValue(
  element: ScreenElement,
  knowledge: { testData: { name: string; value?: string; secret?: string }[] },
  toolResult: string | undefined,
  goal?: string,
): ActionDecision {
  const base = { action: 'type' as const, element: element.n }
  if (toolResult !== undefined) {
    return { ...base, text: toolResult.trim().slice(0, 64) || 'x', reason: 'Value from a tool' }
  }
  // Test data named for this field, a secret or not: the skill says what to type (US4).
  const named = dataFor(element, knowledge.testData)
  if (named) return { ...base, test_data: named.name, reason: `Test data ${named.name} of a skill` }
  // A secret the goal names: the password one for a password field, another for the rest.
  const password = element.flags.includes('password')
  const fromGoal = goalSecrets(goal).find((name) => /pass/i.test(name) === password)
  if (fromGoal && !element.flags.includes('search')) {
    return { ...base, secret: fromGoal, reason: `The goal names secret ${fromGoal}` }
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

/** What the fake knows of the project: named test data, and the skills listed in the prompt. */
export interface FakeKnowledge {
  testData: { name: string; value?: string; secret?: string }[]
  skills?: { name: string; description: string }[]
}

/** A goal or a manual case the fake cannot do alone: a code sent to a phone, a fingerprint. */
const NEEDS_HUMAN = /\b(otp|sms|captcha|fingerprint|face id)\b|vân tay|mã xác (thực|nhận)|tin nhắn/i
/** Steps that say too little to follow (`Làm gì đó…`, `something?`). */
const AMBIGUOUS = /\.\.\.|…|\?|\bsomething\b|gì đó|tùy ý/i

/** Words of a goal that say nothing of the app: common ones, and those of an import's goal. */
const GOAL_NOISE = new Set([
  'open',
  'then',
  'until',
  'with',
  'your',
  'from',
  'into',
  'that',
  'this',
  'done',
  'when',
  'follow',
  'manual',
  'test',
  'case',
  'expected',
  'precondition',
])

/** A goal as the fake follows it: what shows it done comes last (a later place is further). */
interface GoalPlan {
  text: string
  quoted: string[]
  words: string[]
}

function planOf(goal: string): GoalPlan {
  const lines = lower(goal).split('\n')
  const done = (line: string) => line.startsWith('done when:')
  const text = [...lines.filter((l) => !done(l)), ...lines.filter(done)].join('\n')
  return {
    text,
    quoted: [...text.matchAll(/"([^"]+)"|“([^”]+)”/g)].flatMap((m) => {
      const q = (m[1] ?? m[2] ?? '').trim()
      return q ? [q] : []
    }),
    words: text.split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !GOAL_NOISE.has(w)),
  }
}

/**
 * How far along the goal an element is: a label the goal quotes ("Log In") before one sharing a
 * word with it ("… in your cart" for a cart), each by the last place the goal names it.
 */
function goalRank(element: ScreenElement, plan: GoalPlan): [number, number] | undefined {
  const label = lower([element.text, element.desc].filter(Boolean).join(' ')).trim()
  if (!label) return undefined
  const strong = plan.quoted.filter((q) => q === label).map((q) => plan.text.lastIndexOf(`"${q}"`))
  if (strong.length > 0) return [2, Math.max(...strong)]
  const words = label.split(/[^a-z0-9]+/)
  const compact = label.replace(/[^a-z0-9]/g, '')
  const weak = plan.words
    .filter((w) => words.includes(w) || compact === w)
    .map((w) => plan.text.lastIndexOf(w))
  return weak.length > 0 ? [1, Math.max(...weak)] : undefined
}

/** The element furthest along the goal, a new one before one tried; dead ones never. */
function towardGoal(elements: readonly ScreenElement[], goal: string | undefined) {
  if (!goal) return undefined
  const plan = planOf(goal)
  return elements
    .filter((e) => !e.flags.includes('dead'))
    .flatMap((e) => {
      const rank = goalRank(e, plan)
      return rank ? [{ e, rank }] : []
    })
    .sort(
      (a, b) =>
        b.rank[0] - a.rank[0] ||
        b.rank[1] - a.rank[1] ||
        Number(b.e.flags.includes('new')) - Number(a.e.flags.includes('new')),
    )[0]?.e
}

/** An element a skill speaks of: its label is in a skill's description ("Log In" → login skill). */
function mentioned(element: ScreenElement, skills: FakeKnowledge['skills'] = []): boolean {
  const label = lower(element.text ?? element.desc).trim()
  return label.length >= 4 && skills.some((s) => lower(s.description).includes(label))
}

export function fakeDecide(
  input: DecideInput,
  knowledge: FakeKnowledge = { testData: [] },
  toolResult?: string,
): ActionDecision {
  const { screen } = input
  const target = goalTarget(input.goal)
  // Reached only after doing something: a test needs a step.
  if (target && input.history.length > 0) {
    const seen = [
      ...screen.visibleTexts.map((t) => t.text),
      ...screen.elements.map((e) => e.text ?? ''),
    ]
    if (seen.some((t) => lower(t).includes(lower(target)))) {
      return { action: 'done', goal_reached: true, reason: reason(`"${target}" is on the screen`) }
    }
  }
  // The way to the goal was refused (a never_tap button): it cannot be reached (US5).
  if (input.goal && input.refused) {
    return {
      action: 'done',
      goal_reached: false,
      reason: reason(`The goal needs a forbidden action: ${input.refused}`),
    }
  }
  // A goal it cannot follow alone ends at once (US6): a person has to give a code, or the steps
  // say too little.
  if (input.goal && NEEDS_HUMAN.test(input.goal)) {
    return { action: 'done', goal_reached: false, reason: 'A person has to give a code (OTP, SMS)' }
  }
  if (input.goal && AMBIGUOUS.test(input.goal)) {
    return { action: 'done', goal_reached: false, reason: 'The steps say too little to follow' }
  }
  if (input.onlyBack) return { action: 'back', reason: 'Maximum depth reached' }
  // A gullible AI (FR-014 tests): text on a screen with nothing listed tells it to tap, so it taps
  // the middle of the screen — once; the safety checks are what must stop it.
  if (screen.elements.length === 0 && !input.refused && screen.visibleTexts.some(isInjection)) {
    return { action: 'tap_point', point_pct: [0.5, 0.5], reason: 'The screen says to tap it' }
  }
  const fresh = screen.elements.filter((e) => e.flags.includes('new') && !e.flags.includes('dead'))
  // Following the project (US4): with test data (or secrets the goal names), fill a form before
  // leaving it; then what the goal speaks of, furthest first (US5, US6); then what a skill
  // speaks of; then the first element not tried yet.
  const fill = knowledge.testData.length > 0 || goalSecrets(input.goal).length > 0
  const next =
    (fill ? fresh.find((e) => e.flags.includes('field')) : undefined) ??
    towardGoal(screen.elements, input.goal) ??
    fresh.find((e) => mentioned(e, knowledge.skills)) ??
    fresh[0]
  if (!next) return { action: 'back', reason: 'Nothing new on this screen' }
  if (next.flags.includes('field')) return fieldValue(next, knowledge, toolResult, input.goal)
  if (next.flags.includes('scroll')) {
    return { action: 'swipe', element: next.n, direction: 'up', reason: 'See more of the list' }
  }
  const label = next.text ?? next.desc ?? next.id ?? `#${next.n}`
  const why = next.flags.includes('new') ? 'not tried yet' : 'the way to the goal'
  return { action: 'tap', element: next.n, reason: reason(`Try "${label}", ${why}`) }
}

/**
 * How a manual case went, by its text and the trace (US6): a code a person has to give, steps
 * that say too little, or an expected text (quoted) the app never showed. Undefined: written.
 */
function judgeManualCase(
  input: WriteTestInput,
  done: readonly WriteTestInput['steps'][number][],
): TestPlan | undefined {
  const manual = input.manualCase
  if (!manual) return undefined
  const text = [
    manual.title,
    ...manual.preconditions,
    ...manual.steps.flatMap((s) => [s.action, s.expected ?? '']),
  ].join('\n')
  const evidence = done[done.length - 1]?.n ?? input.steps[input.steps.length - 1]?.n ?? 1
  if (NEEDS_HUMAN.test(text)) {
    return {
      flows: [],
      outcome: 'needs_human',
      evidence_step: evidence,
      explanation: 'A person has to give a code sent to a phone (OTP, SMS)',
    }
  }
  if (AMBIGUOUS.test(text)) {
    return {
      flows: [],
      outcome: 'ambiguous',
      evidence_step: evidence,
      explanation: 'The steps say too little to know what to do',
    }
  }
  const expected = [...manual.steps].reverse().find((s) => s.expected)?.expected
  const target = goalTarget(expected)
  const seen = input.steps.flatMap((s) => [s.screen, s.after, ...s.textsAfter])
  if (target && !seen.some((t) => lower(t).includes(lower(target)))) {
    return {
      flows: [],
      outcome: 'app_mismatch',
      evidence_step: evidence,
      explanation: `The app never showed "${target}"`,
    }
  }
  return undefined
}

/** Lowercase words joined by dashes, as a test case slug wants them. */
const slugOf = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'screen'

/** The expectation the fake keeps for a step: the Recorder's first suggestion, else new text. */
function expectOf(step: WriteTestInput['steps'][number]): Flow['expects'] {
  if (step.candidates.length > 0) return [{ step: step.n, candidate: 0 }]
  const text = step.textsAfter[0]
  return text ? [{ step: step.n, visible_text: text }] : []
}

/**
 * The fake writer (research R12). Free exploration: one flow for each screen a segment reached
 * for the first time — "open <screen>", from the segment's start to that step — at most
 * `maxTests`. A goal or a manual case: one flow, the last segment to its last done step.
 */
export function fakeWrite(input: WriteTestInput): TestPlan {
  // Steps done on the app (the AI's `done` on a goal acts on nothing).
  const done = input.steps.filter((s) => s.status === 'done' && s.action !== 'done')
  if (input.manualCase) {
    const judged = judgeManualCase(input, done)
    if (judged) return judged
  }
  if (done.length === 0) {
    return input.kind === 'import'
      ? { flows: [], outcome: 'app_mismatch', explanation: 'No step could be done on the app' }
      : { flows: [], outcome: 'written' }
  }
  if (input.kind !== 'explore') {
    const segment = done[done.length - 1]?.segment ?? 1
    const steps = done.filter((s) => s.segment === segment)
    const last = steps[steps.length - 1] ?? done[0]
    const withExpect = [...steps].reverse().find((s) => expectOf(s).length > 0)
    const name = input.manualCase?.title ?? input.goal ?? `Flow to ${last?.after ?? 'the end'}`
    // The goal's quoted text, on the screen the last step reached: the goal is reached.
    const target = goalTarget(input.goal)
    const reached = target && last ? [{ step: last.n, visible_text: target }] : []
    return {
      flows: [
        {
          slug: slugOf(name),
          name: name.slice(0, 80),
          intent: (input.goal ?? input.manualCase?.title ?? name).slice(0, 300),
          segment,
          end_step: last?.n ?? 1,
          expects: [...(withExpect ? expectOf(withExpect) : []), ...reached].filter(
            (e, i, all) => all.findIndex((o) => JSON.stringify(o) === JSON.stringify(e)) === i,
          ),
        },
      ],
      outcome: 'written',
    }
  }
  const taken = new Set<string>()
  const flows: Flow[] = []
  for (const step of done) {
    if (!step.newScreen || flows.length >= input.maxTests) continue
    let slug = `open-${slugOf(step.after)}`
    for (let i = 2; taken.has(slug); i += 1) slug = `open-${slugOf(step.after)}-${i}`
    taken.add(slug)
    flows.push({
      slug,
      name: `Open ${step.after}`.slice(0, 80),
      intent: `From the start of the app, ${step.action} reaches "${step.after}"`.slice(0, 300),
      segment: step.segment,
      end_step: step.n,
      expects: expectOf(step),
    })
  }
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
      if (request.toolChoice === 'auto' && request.tools.length > 0) {
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
      return fakeDecide(task.input, knowledgeOf(request.system.stable), toolResult)
    case 'write_test':
      return fakeWrite(task.input)
  }
}

/**
 * The fake reads the project back from the stable prompt: named test data (`- NAME: secret X` /
 * `- NAME: "v"`) and the skills listed (`- name: description`).
 */
function knowledgeOf(stable: string): FakeKnowledge {
  const skills = (/## Skills[^\n]*\n([\s\S]*?)(?:\n## |$)/.exec(stable)?.[1] ?? '')
    .split('\n')
    .map((line) => /^- ([a-z0-9][a-z0-9-]*): (.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: m[1] ?? '', description: m[2] ?? '' }))
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
  return { testData, skills }
}
