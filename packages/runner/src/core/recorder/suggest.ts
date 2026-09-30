import { walkTree, type ElementNode, type ExpectCondition } from '@coral/shared'
import { conditionFailure } from '../expect'
import { intersectsScreen } from '../locator/geometry'
import type { ResolveContext } from '../locator/resolve'
import { idLocator, isInput } from './locators'

export const MAX_SUGGESTIONS = 3

const normalize = (text: string) => text.trim().replace(/\s+/g, ' ')
/** Digits, prices, times, percentages: they change from run to run. */
const NUMERIC = /^[\d\s.,:;%$€£¥+\-/()]*$/
const SYSTEM = /^com\.android\.systemui$|inputmethod|keyboard/i

/** Visible on-screen nodes of the app under test (anything but system bars and the keyboard). */
function appNodes(tree: readonly ElementNode[], ctx: ResolveContext): ElementNode[] {
  return [...walkTree(tree)].filter(
    (n) =>
      n.visible &&
      intersectsScreen(n.bounds, ctx.screen) &&
      (ctx.appId ? n.package_or_bundle === ctx.appId : !SYSTEM.test(n.package_or_bundle)),
  )
}

/** Texts worth waiting for: no input content (maybe a secret), nothing short or numeric. */
function texts(nodes: readonly ElementNode[]): Map<string, ElementNode> {
  const out = new Map<string, ElementNode>()
  for (const node of nodes) {
    const text = normalize(node.text)
    if (isInput(node) || text.length <= 2 || NUMERIC.test(text) || out.has(text)) continue
    out.set(text, node)
  }
  return out
}

const ids = (nodes: readonly ElementNode[]) =>
  new Map(nodes.filter((n) => n.platform_id !== '').map((n) => [n.platform_id, n] as const))

/** Bigger text first (a title), then higher on the screen. */
const prominence = (a: ElementNode, b: ElementNode) =>
  b.bounds.h - a.bounds.h || a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x

/**
 * Expectations to offer after a recorded action (FR-013a, research R9), from the trees before and
 * after it: a text of the app that appeared (`visible_text`), an element id that appeared
 * (`visible`), an element id that went away (`not_visible`) — taken in turn, at most three, each
 * one holding on the tree after. Nothing new on screen gives none.
 */
export function suggestExpects(
  before: readonly ElementNode[],
  after: readonly ElementNode[],
  ctx: ResolveContext,
): ExpectCondition[] {
  const was = appNodes(before, ctx)
  const now = appNodes(after, ctx)
  const oldTexts = texts(was)
  const newTexts = [...texts(now)]
    .filter(([text]) => !oldTexts.has(text))
    .sort(([, a], [, b]) => prominence(a, b))
    .map(([text]): ExpectCondition => ({ visible_text: text }))
  const oldIds = ids(was)
  const nowIds = ids(now)
  const appeared = [...nowIds.values()]
    .filter((n) => !oldIds.has(n.platform_id))
    .sort(prominence)
    .flatMap((n): ExpectCondition[] => {
      const locator = idLocator(n, ctx)
      return locator ? [{ visible: locator }] : []
    })
  const gone = [...oldIds.values()]
    .filter((n) => !nowIds.has(n.platform_id))
    .sort(prominence)
    .flatMap((n): ExpectCondition[] => {
      const locator = idLocator(n, ctx)
      return locator ? [{ not_visible: locator }] : []
    })

  const out: ExpectCondition[] = []
  const lists = [newTexts, appeared, gone]
  for (let i = 0; out.length < MAX_SUGGESTIONS && lists.some((l) => i < l.length); i += 1) {
    for (const list of lists) {
      const condition = list[i]
      if (!condition || out.length >= MAX_SUGGESTIONS) continue
      if (conditionFailure(condition, after, ctx) === undefined) out.push(condition)
    }
  }
  return out
}
