import {
  STEP_DEFAULTS,
  fingerprintContext,
  screenFingerprint,
  walkTree,
  type ElementNode,
  type ExpectCondition,
  type Locator,
} from '@coral/shared'
import { throwIfAborted, type Clock } from './clock'
import type { TargetLifecycle, UiDriver } from './driver'
import { intersectsScreen } from './locator/geometry'
import { resolve, type ResolveContext } from './locator/resolve'

export const EXPECT_POLL_MS = 250

const normalize = (text: string) => text.trim().replace(/\s+/g, ' ')
const asList = (value: Locator | Locator[]) => (Array.isArray(value) ? value : [value])

/** Why one condition does not hold on this tree, or undefined when it does. */
export function conditionFailure(
  condition: ExpectCondition,
  tree: readonly ElementNode[],
  ctx: ResolveContext,
): string | undefined {
  if (condition.visible_text !== undefined) {
    // Visible node whose text contains the value (normalised whitespace, case-sensitive).
    const wanted = normalize(condition.visible_text)
    for (const node of walkTree(tree)) {
      if (node.visible && intersectsScreen(node.bounds, ctx.screen)) {
        if (normalize(node.text).includes(wanted)) return undefined
      }
    }
    return `text "${condition.visible_text}" is not visible`
  }
  if (condition.visible !== undefined) {
    // Any locator of the list may match (§7.3).
    return resolve(asList(condition.visible), tree, ctx)
      ? undefined
      : `element ${JSON.stringify(condition.visible)} is not visible`
  }
  if (condition.not_visible !== undefined) {
    const found = resolve(asList(condition.not_visible), tree, ctx)
    return found ? `element ${JSON.stringify(condition.not_visible)} is still visible` : undefined
  }
  if (condition.screen !== undefined) {
    const expected = ctx.screens?.[condition.screen]
    if (!expected) return `screen "${condition.screen}" is not in the app map`
    const actual = screenFingerprint(
      tree,
      ctx.appId ? { package: ctx.appId, ...(ctx.activity ? { activity: ctx.activity } : {}) } : {},
    )
    return actual === expected
      ? undefined
      : `screen "${condition.screen}" is not shown (fingerprint ${actual}, expected ${expected})`
  }
  return 'unknown expectation'
}

/** First failing condition of a list; all must hold on the same tree. */
export function expectFailure(
  conditions: readonly ExpectCondition[],
  tree: readonly ElementNode[],
  ctx: ResolveContext,
): string | undefined {
  for (const condition of conditions) {
    const failure = conditionFailure(condition, tree, ctx)
    if (failure) return failure
  }
  return undefined
}

export interface ExpectOutcome {
  ok: boolean
  /** Last tree read (the one that satisfied the conditions when ok). */
  tree: ElementNode[]
  message?: string
}

/**
 * Polls every 250 ms until every condition holds or the longest `timeout_ms` of the list
 * (default 5000) is over (§7.3, research R5).
 */
export async function checkExpect(
  conditions: readonly ExpectCondition[],
  driver: Pick<UiDriver, 'tree'> & Partial<Pick<TargetLifecycle, 'foregroundActivity'>>,
  clock: Clock,
  ctx: ResolveContext,
  options: { pollMs?: number; signal?: AbortSignal } = {},
): Promise<ExpectOutcome> {
  const timeout = Math.max(...conditions.map((c) => c.timeout_ms ?? STEP_DEFAULTS.expectTimeoutMs))
  const wantsScreen = conditions.some((c) => c.screen !== undefined)
  const start = clock.now()
  for (;;) {
    throwIfAborted(options.signal)
    const tree = await driver.tree()
    // The activity is read with the tree: a screen's fingerprint includes it (D24).
    let at = ctx
    if (wantsScreen) {
      const foreground = await driver.foregroundActivity?.().catch(() => undefined)
      const { activity } = fingerprintContext(ctx.appId ?? '', foreground)
      at = { ...ctx, ...(activity ? { activity } : {}) }
    }
    const message = expectFailure(conditions, tree, at)
    if (!message) return { ok: true, tree }
    if (clock.now() - start >= timeout) return { ok: false, tree, message }
    await clock.sleep(options.pollMs ?? EXPECT_POLL_MS, options.signal)
  }
}
