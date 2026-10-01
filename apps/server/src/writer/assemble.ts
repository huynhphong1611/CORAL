import { expectFailure, type ResolveContext } from '@coral/runner'
import {
  recordingToYaml,
  referenceSecrets,
  type ElementNode,
  type ExpectCondition,
  type Flow,
  type Locator,
  type Step,
  type TestCase,
  type ValidationIssue,
  type api,
} from '@coral/shared'
import { contentHash } from '../explorer/trace'
import type { ExplorationFile } from '../storage/keys'

/** A trace step as the writer reads it (`exploration_steps`). */
export interface WriterRow {
  n: number
  segment: number
  fingerprint: string
  status: api.ExplorationStepStatus
  step: Step | null
  suggestions: ExpectCondition[]
  flags: api.StepFlag[]
}

export interface AssembleInput {
  flow: Flow
  /** The test case's id: the flow's slug, made free in the project by the caller. */
  slug: string
  /** The whole trace, every status. */
  rows: readonly WriterRow[]
  /** What `observe` saw before trace step `n` (its tree.json), when it can be read. */
  tree: (n: number) => readonly ElementNode[] | undefined
  /** The element cut-out of step `n` exists (its image locator can be kept). */
  hasElement: (n: number) => boolean
  appPackage: string
  /** Secret values, name → value: none may reach the YAML (FR-013). */
  secrets: Readonly<Record<string, string>>
}

/** Where a snapshot file of the test case comes from in the exploration's trace. */
export interface SnapshotSource {
  path: string
  n: number
  file: ExplorationFile
}

export interface Assembled {
  testCase: TestCase
  yaml: string
  snapshots: SnapshotSource[]
  flags: api.TestCaseFlag[]
  draftReason: api.DraftReason | null
  /** Actions and first locators in order: two test cases with the same one are duplicates. */
  signature: string
  warnings: ValidationIssue[]
  /** Trace steps the test case replays, in order. */
  kept: number[]
}

export class AssembleError extends Error {
  constructor(
    readonly code: 'no_steps' | 'invalid',
    message: string,
    readonly issues: ValidationIssue[] = [],
  ) {
    super(message)
    this.name = 'AssembleError'
  }
}

const RECORDING_IMAGE = (stepId: string) => `snap/recording/${stepId}/element.png`
const snapshotPath = (slug: string, stepId: string, file: string) =>
  `snap/${slug}/${stepId}/${file}`
const targetOf = (step: Step): Locator[] | undefined =>
  'target' in step && step.target ? step.target : undefined
const firstLocator = (step: Step) => JSON.stringify(targetOf(step)?.[0] ?? null)

/** The size the trees were dumped at: the widest and tallest window. */
function sizeOf(tree: readonly ElementNode[]) {
  let width = 1
  let height = 1
  for (const window of tree) {
    width = Math.max(width, window.bounds.x + window.bounds.w)
    height = Math.max(height, window.bounds.y + window.bounds.h)
  }
  return { width, height }
}

/** What a person sees of the app under test (status bar and keyboard left out). */
const appContent = (tree: readonly ElementNode[] | undefined, appPackage: string) =>
  tree ? contentHash(tree.filter((w) => w.package_or_bundle === appPackage)) : undefined

/** The flow's slug, else with `-2`, `-3`… when the project already has it. */
export function freeSlug(taken: ReadonlySet<string>, slug: string): string {
  if (!taken.has(slug)) return slug
  for (let i = 2; ; i += 1) {
    const suffix = `-${i}`
    const candidate = `${slug.slice(0, 64 - suffix.length).replace(/-+$/, '')}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

/** `action` and first locator of each step after launch: equal signatures = the same test. */
export function signatureOf(steps: readonly Step[]): string {
  return JSON.stringify(
    steps.filter((s) => s.action !== 'launch').map((s) => [s.action, firstLocator(s)]),
  )
}

/**
 * Turns one flow the writer chose into a self-contained `coral/testcase@1` (research R12) — all
 * deterministic, no AI:
 * - `launch` with `app_state: fresh`, then the recorded steps of the flow's segment up to
 *   `end_step` (refused, failed, popup and restart rows left out);
 * - round trips removed: from a screen back to the same screen with the same content on it
 *   (fingerprint and visible content), unless the round trip typed something or ends the flow;
 * - a tap on a field followed by typing into it becomes one `type` step with that target;
 * - expectations: the writer's are kept only when they hold on the tree the trace saw after the
 *   step (FR-029); a tap left without one gets the Recorder's first suggestion that holds;
 * - secret values become `${secret:NAME}`; image locators point at the test case's snapshots.
 */
export function assemble(input: AssembleInput): Assembled {
  const { flow, rows, appPackage } = input
  const sorted = [...rows].sort((a, b) => a.n - b.n)
  const segment = sorted.filter((r) => r.segment === flow.segment)
  const next = new Map<number, WriterRow>()
  for (let i = 0; i + 1 < segment.length; i += 1) {
    const row = segment[i]
    const after = segment[i + 1]
    if (row && after) next.set(row.n, after)
  }
  const acted = segment.filter(
    (r): r is WriterRow & { step: Step } =>
      r.n <= flow.end_step && r.status === 'done' && r.step !== null,
  )
  if (acted.length === 0) throw new AssembleError('no_steps', 'the flow has no recorded step')
  const last = acted[acted.length - 1]
  if (!last || last.n !== flow.end_step) {
    throw new AssembleError('no_steps', `step ${flow.end_step} is not a recorded step`)
  }
  const treeAfter = (n: number) => {
    const after = next.get(n)
    return after ? input.tree(after.n) : undefined
  }
  const fingerprintAfter = (n: number) => next.get(n)?.fingerprint

  // Round trips that changed nothing visible.
  let kept = [...acted]
  for (let i = 0; i < kept.length; i += 1) {
    const from = kept[i]
    if (!from) break
    const before = appContent(input.tree(from.n), appPackage)
    if (before === undefined) continue
    for (let j = kept.length - 2; j >= i; j -= 1) {
      const to = kept[j]
      if (!to || fingerprintAfter(to.n) !== from.fingerprint) continue
      if (appContent(treeAfter(to.n), appPackage) !== before) continue
      if (kept.slice(i, j + 1).some((r) => r.step.action === 'type')) continue
      kept = [...kept.slice(0, i), ...kept.slice(j + 1)]
      i -= 1
      break
    }
  }

  // tap on a field + type into it → one type step with that target.
  const merged: (WriterRow & { step: Step })[] = []
  for (const row of kept) {
    const previous = merged[merged.length - 1]
    if (
      previous?.step.action === 'tap' &&
      row.step.action === 'type' &&
      (!targetOf(row.step) || firstLocator(row.step) === firstLocator(previous.step))
    ) {
      merged.pop()
      const target = targetOf(row.step) ?? targetOf(previous.step)?.filter((l) => !l.image)
      merged.push({ ...row, step: { ...row.step, ...(target ? { target } : {}) } })
      continue
    }
    merged.push(row)
  }

  // Expectations that hold on what the trace saw after each step.
  const wanted = new Map<number, ExpectCondition[]>()
  for (const expect of flow.expects) {
    const row = segment.find((r) => r.n === expect.step)
    const condition =
      expect.visible_text !== undefined
        ? { visible_text: expect.visible_text }
        : row?.suggestions[expect.candidate ?? -1]
    if (!condition) continue
    wanted.set(expect.step, [...(wanted.get(expect.step) ?? []), condition])
  }
  const holds = (condition: ExpectCondition, tree: readonly ElementNode[]) => {
    const ctx: ResolveContext = { platform: 'android', screen: sizeOf(tree), appId: appPackage }
    return expectFailure([condition], tree, ctx) === undefined
  }
  const steps: Step[] = [{ id: 's1', action: 'launch' }]
  const snapshots: SnapshotSource[] = []
  const first = segment[0]
  if (first) {
    snapshots.push(
      { path: snapshotPath(input.slug, 's1', 'screen.jpg'), n: first.n, file: 'screen.jpg' },
      { path: snapshotPath(input.slug, 's1', 'tree.json'), n: first.n, file: 'tree.json' },
    )
  }
  for (const row of merged) {
    const id = `s${steps.length + 1}`
    const tree = treeAfter(row.n)
    // A text the writer made up that equals a secret value is dropped, never referenced.
    const fromWriter = (wanted.get(row.n) ?? []).filter(
      (c) => JSON.stringify(referenceSecrets(c, input.secrets)) === JSON.stringify(c),
    )
    let conditions = tree ? fromWriter.filter((c) => holds(c, tree)) : []
    if (
      conditions.length === 0 &&
      tree &&
      (row.step.action === 'tap' || row.step.action === 'long_press')
    ) {
      const suggestion = row.suggestions.find((c) => holds(c, tree))
      if (suggestion) conditions = [suggestion]
    }
    const target = targetOf(row.step)?.flatMap((locator): Locator[] => {
      if (locator.image === undefined) return [locator]
      if (!input.hasElement(row.n)) return []
      const image = typeof locator.image === 'string' ? { path: '' } : locator.image
      return [{ image: { ...image, path: RECORDING_IMAGE(id) } }]
    })
    // The recorded step's own expectation (none from the Recorder) gives way to the checked ones.
    const recorded: Record<string, unknown> = { ...row.step }
    delete recorded.expect
    steps.push({
      ...recorded,
      id,
      ...(target && target.length > 0 ? { target } : {}),
      ...(conditions.length > 0 ? { expect: conditions } : {}),
    } as Step)
    snapshots.push(
      { path: snapshotPath(input.slug, id, 'screen.jpg'), n: row.n, file: 'step.jpg' },
      { path: snapshotPath(input.slug, id, 'tree.json'), n: row.n, file: 'step.json' },
    )
    if (target?.some((l) => l.image !== undefined)) {
      snapshots.push({
        path: snapshotPath(input.slug, id, 'element.png'),
        n: row.n,
        file: 'element.png',
      })
    }
  }

  const masked = referenceSecrets(steps, input.secrets)
  const paths = new Set(snapshots.map((s) => s.path))
  const { yaml, validation } = recordingToYaml(
    { slug: input.slug, intent: flow.intent, steps: masked.map((step) => ({ step })) },
    { fileExists: (path) => paths.has(path) },
  )
  if (!validation.valid || !validation.value) {
    throw new AssembleError('invalid', 'the assembled test case is not valid', validation.errors)
  }
  const flags = new Set(merged.flatMap((r) => r.flags))
  return {
    testCase: validation.value,
    yaml,
    snapshots,
    flags: flags.has('never_tap') ? ['needs_review_never_tap'] : [],
    draftReason: flags.has('mcp_value') ? 'needs_human' : null,
    signature: signatureOf(validation.value.steps),
    warnings: validation.warnings,
    kept: merged.map((r) => r.n),
  }
}
