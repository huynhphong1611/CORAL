import {
  STEP_DEFAULTS,
  walkTree,
  type ElementNode,
  type ExpectCondition,
  type Locator,
} from '@coral/shared'
import { throwIfAborted, type Clock } from './clock'
import type { UiDriver } from './driver'
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
  return 'expect.screen is not supported in Phase 1'
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
  driver: Pick<UiDriver, 'tree'>,
  clock: Clock,
  ctx: ResolveContext,
  options: { pollMs?: number; signal?: AbortSignal } = {},
): Promise<ExpectOutcome> {
  const timeout = Math.max(...conditions.map((c) => c.timeout_ms ?? STEP_DEFAULTS.expectTimeoutMs))
  const start = clock.now()
  for (;;) {
    throwIfAborted(options.signal)
    const tree = await driver.tree()
    const message = expectFailure(conditions, tree, ctx)
    if (!message) return { ok: true, tree }
    if (clock.now() - start >= timeout) return { ok: false, tree, message }
    await clock.sleep(options.pollMs ?? EXPECT_POLL_MS, options.signal)
  }
}
