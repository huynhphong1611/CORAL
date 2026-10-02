import type { ActionDecision, BrainProviderId, ScreenSummary, TestPlan, api } from '@coral/shared'

/**
 * The brain layer's contract (SPEC §14.1, contracts/brain.md). The server builds the inputs from
 * what the agent observed — already filtered (never_tap, forbidden elements) and with secret
 * values replaced by `${secret:NAME}` — and gets checked answers back. Nothing here talks to a
 * device: the AI writes, scripts run (P1).
 */

// ---- inputs ---------------------------------------------------------------------------------------

export const ELEMENT_FLAGS = [
  'new',
  'tried',
  'dead',
  'field',
  'password',
  'search',
  'scroll',
] as const
export type ElementFlag = (typeof ELEMENT_FLAGS)[number]

/** One element of the numbered list the AI picks from (research R6). */
export interface ScreenElement {
  /** `#n` in the list: what the AI answers with. */
  n: number
  /** Short class name, e.g. `EditText`. */
  className: string
  id?: string
  text?: string
  desc?: string
  /** Device pixels: x, y, width, height. */
  bounds: [number, number, number, number]
  flags: ElementFlag[]
}

export interface ImageInput {
  mediaType: 'image/jpeg' | 'image/png'
  /** Base64 content sent to the provider. */
  data: string
  /** Where the image is stored (the call's content keeps this, never the bytes). */
  ref?: string
}

export interface ScreenInput {
  width: number
  height: number
  appPackage: string
  /** Name of the screen in the app map, when already known. */
  knownAs?: string
  /** At most 80, in reading order. */
  elements: ScreenElement[]
  /** Text visible on the screen with its height in pixels (titles stand out), reading order. */
  visibleTexts: { text: string; height: number }[]
  /**
   * Labels of what is on this screen but never to be tapped (never_tap, forbidden by a skill):
   * left out of `elements`, named so that a goal needing one can be told unreachable (US5).
   */
  forbidden?: string[]
  /** The downscaled screenshot (long edge ≤ 1024 px); omitted for providers without vision. */
  image?: ImageInput
}

export interface DecideInput {
  screen: ScreenInput
  /** Goal mode (US5, import): what the user wants done. */
  goal?: string
  /** The last steps, oldest first: what was done and where. */
  history: { n: number; screen: string; action: string; outcome: string }[]
  budget: {
    stepsLeft: number
    depth: number
    maxDepth: number
    costUsd: number
    maxCostUsd: number
  }
  /** Beyond `max_depth`: only `back` is acceptable. */
  onlyBack?: boolean
  /** Why the previous decision on this screen was refused, so the AI picks something else. */
  refused?: string
}

/** One step of the trace as the writer sees it (research R12). */
export interface TraceStepInput {
  n: number
  segment: number
  /** Name of the screen before the step and after it. */
  screen: string
  after: string
  /** The screen after was not seen before in this segment. */
  newScreen: boolean
  /** What was done, e.g. `tap "Log In" (#4)`. */
  action: string
  status: api.ExplorationStepStatus
  /** Text that appeared on the screen with the step. */
  textsAfter: string[]
  /** Expectation candidates for this step, numbered from 0 (the Recorder's suggestions). */
  candidates: string[]
  /** `never_tap`, `mcp_value`, `invented_text` (the system sets what they mean for a test case). */
  flags: api.StepFlag[]
}

export interface ManualCaseInput {
  title: string
  preconditions: string[]
  steps: { action: string; expected?: string }[]
}

export interface WriteTestInput {
  kind: api.ExplorationKind
  goal?: string
  manualCase?: ManualCaseInput
  maxTests: number
  steps: TraceStepInput[]
}

// ---- call context ---------------------------------------------------------------------------------

/** What the project tells every AI role (§13): only the project being run (FR-012). */
export interface ProjectKnowledge {
  /** `AGENTS.md`, cut at 16 KB. */
  agentsMd: string
  /** Names and descriptions; contents are read with the `read_skill` tool. */
  skills: { name: string; description: string }[]
  /** Named test data from `rules.yaml`: values of plain data, only names of secrets. */
  testData: { name: string; value?: string; secret?: string }[]
}

export const EMPTY_KNOWLEDGE: ProjectKnowledge = { agentsMd: '', skills: [], testData: [] }

export interface ToolSpec {
  /** `<server>__<tool>` for MCP, or an internal tool such as `read_skill`. */
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ToolOutcome {
  /** What the AI reads back: cut at 8 KB, secrets masked. */
  result: string
  ok: boolean
  blocked?: boolean
  error?: api.ToolCallError
  latencyMs?: number
}

/** The tools of one activity: the MCP allowlist and the internal ones (contracts/brain.md §4). */
export interface ToolSet {
  specs: ToolSpec[]
  /** Runs a call; a name not in `specs` must come back blocked with `not_allowed`. */
  call(name: string, args: unknown): Promise<ToolOutcome>
}

export const NO_TOOLS: ToolSet = {
  specs: [],
  call: () =>
    Promise.resolve({
      result: JSON.stringify({ error: 'not_allowed' }),
      ok: false,
      blocked: true,
      error: 'not_allowed',
    }),
}

export type BrainCallRole = api.BrainCallRole

export interface CallContext {
  tenantId: string
  role: BrainCallRole
  /** The activity the cost and the call records belong to. */
  ref: { type: api.BrainCallRefType; id: string }
  /** The activity's budget; the router refuses a call once it is spent (FR-007). */
  budget: { maxCostUsd: number; spentUsd: () => Promise<number> }
  knowledge: ProjectKnowledge
  tools: ToolSet
}

export interface Brain {
  describeScreen(input: ScreenInput, ctx: CallContext): Promise<ScreenSummary>
  nextAction(input: DecideInput, ctx: CallContext): Promise<ActionDecision>
  writeTest(input: WriteTestInput, ctx: CallContext): Promise<TestPlan>
}

// ---- provider adapters ----------------------------------------------------------------------------

export interface ToolCall {
  id: string
  name: string
  args: unknown
}

export type ChatMessage =
  | { role: 'user'; text: string; images?: ImageInput[] }
  | {
      role: 'assistant'
      text?: string
      toolCalls?: ToolCall[]
      /**
       * The turn as the provider gave it (e.g. Claude's thinking blocks), sent back unchanged
       * to the same provider in the same conversation; never stored, never sent elsewhere.
       */
      providerState?: unknown
    }
  | { role: 'tool'; results: { id: string; name: string; content: string; isError?: boolean }[] }

/**
 * What the request is for. Real adapters ignore it; the scripted `fake` adapter answers from it
 * so CI runs without a network (research R2).
 */
export type ChatTask =
  | { kind: 'describe_screen'; input: ScreenInput }
  | { kind: 'next_action'; input: DecideInput }
  | { kind: 'write_test'; input: WriteTestInput }

export interface ChatRequest {
  model: string
  /** `stable` comes first so providers can cache it; `volatile` changes every call. */
  system: { stable: string; volatile: string }
  messages: ChatMessage[]
  /** The activity's tools, the same on every round (a provider must declare those used before). */
  tools: ToolSpec[]
  /** `none` on the round that must give the final answer: no more tool calls. */
  toolChoice: 'auto' | 'none'
  /** JSON Schema of the final answer. */
  outputSchema: Record<string, unknown>
  options: { effort?: string; timeoutMs: number }
  task: ChatTask
  /**
   * For an adapter that runs tools itself (`runsTools`): runs one call of the activity's tools,
   * within the same limit of rounds; past it the answer tells the AI to answer now.
   */
  callTool?: (name: string, args: unknown) => Promise<ToolOutcome>
}

/** Tokens of one provider call; adapters report input read from cache apart from the rest. */
export interface Usage {
  /** Input tokens not read from the prompt cache (cache writes included). */
  input: number
  output: number
  /** Input tokens read from the prompt cache, billed at the cached price. */
  cachedInput: number
  /** Calls billed by request (Copilot premium requests), at the model's `per_request` price. */
  requests?: number
}

export interface ChatResponse {
  kind: 'final' | 'tool_calls'
  text?: string
  toolCalls?: ToolCall[]
  usage: Usage
  stop: 'end' | 'max_tokens' | 'refusal' | 'tool_use'
  /** Opaque to everything but the adapter: copied into the assistant turn of the conversation. */
  providerState?: unknown
}

export interface ProviderAdapter {
  id: BrainProviderId
  vision: boolean
  /**
   * The provider runs the tool loop itself (an agent such as Copilot): it calls
   * `request.callTool` and always answers `final`.
   */
  runsTools?: boolean
  chat(request: ChatRequest): Promise<ChatResponse>
}

// ---- errors ---------------------------------------------------------------------------------------

export const PROVIDER_ERROR_KINDS = [
  'timeout',
  'rate_limited',
  'auth',
  'refusal',
  'provider_error',
  'bad_request',
] as const
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number]

/** A provider failure in a provider-neutral form; the router falls back on every kind but `bad_request`. */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'ProviderError'
  }
}

/** The answer still broke its schema after the re-asks: nothing is done with it (FR-002). */
export class BrainOutputError extends Error {
  constructor(
    message: string,
    readonly validationErrors: string[],
  ) {
    super(message)
    this.name = 'BrainOutputError'
  }
}

/** The daily limit of the tenant or the budget of the activity is spent (FR-007). */
export class BudgetExceededError extends Error {
  constructor(
    readonly scope: 'daily' | 'activity',
    message: string,
  ) {
    super(message)
    this.name = 'BudgetExceededError'
  }
}

/** No provider could answer: each tried one failed (the last error is the cause). */
export class BrainUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BrainUnavailableError'
  }
}
