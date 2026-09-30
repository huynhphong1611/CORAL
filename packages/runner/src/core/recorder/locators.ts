import { walkTree, type ElementNode, type ImageLocator, type Locator } from '@coral/shared'
import { classMatches } from '../locator/class-match'
import { center, intersectsScreen } from '../locator/geometry'
import { relDistance, type RelDirection } from '../locator/rel'
import { resolve, type ResolveContext } from '../locator/resolve'

export interface LocatorOptions {
  /** The element's cut-out, for a step that touches it: always in the chain (FR-012). */
  image?: ImageLocator
}

const normalize = (text: string) => text.trim().replace(/\s+/g, ' ')
const shortClass = (name: string) => name.slice(name.lastIndexOf('.') + 1)
const within = (node: ElementNode, ancestor: ElementNode) => node.ref.startsWith(`${ancestor.ref}.`)
/** What a user types: an input's text is its content, never a way to find it (and may be secret). */
export const isInput = (node: ElementNode) =>
  node.android?.password === true || classMatches(node.class, 'EditText')

/** `id/<name>` for the app's own ids (as test cases write them), the full id otherwise. */
export function idLocator(node: ElementNode, ctx: ResolveContext): Locator | undefined {
  const id = node.platform_id
  if (!id) return undefined
  if (ctx.platform === 'ios') return { ios_id: id }
  const own = ctx.appId ? `${ctx.appId}:` : undefined
  return { android_id: own && id.startsWith(own) ? id.slice(own.length) : id }
}

/**
 * `rel` to the nearest label (a node with text, outside the target, in the same window — never the
 * status bar clock or a dialog above) above it, else to its left, with the target's short class
 * (research R8.2).
 */
function relLocators(target: ElementNode, tree: readonly ElementNode[], ctx: ResolveContext) {
  const window = tree.find((w) => w.ref === target.ref || within(target, w))
  const labels = [...walkTree(window ? [window] : [])].filter(
    (n) =>
      n.visible &&
      normalize(n.text) !== '' &&
      !isInput(n) &&
      n.ref !== target.ref &&
      !within(n, target) &&
      !within(target, n) &&
      intersectsScreen(n.bounds, ctx.screen),
  )
  const out: Locator[] = []
  // A label above the target gives `below: label`, one to its left `right_of: label`.
  const directions: readonly RelDirection[] = ['below', 'right_of']
  for (const direction of directions) {
    let nearest: { label: ElementNode; distance: number } | undefined
    for (const label of labels) {
      const distance = relDistance(direction, label.bounds, target.bounds)
      if (distance !== undefined && (!nearest || distance < nearest.distance)) {
        nearest = { label, distance }
      }
    }
    if (nearest) {
      const anchor = { text: normalize(nearest.label.text) }
      out.push({ rel: { [direction]: anchor, class: shortClass(target.class) } })
    }
  }
  return out
}

/**
 * `class_index` among the nodes of the target's class inside its nearest ancestor with an id; none
 * without such an ancestor (an index over the whole screen breaks on any change).
 */
function classIndexLocator(
  target: ElementNode,
  tree: readonly ElementNode[],
  ctx: ResolveContext,
): Locator | undefined {
  const all = [...walkTree(tree)]
  const ancestors = all
    .filter((n) => within(target, n) && n.platform_id !== '')
    .sort((a, b) => b.ref.length - a.ref.length)
  const container = ancestors[0]
  const containerLocator = container ? idLocator(container, ctx) : undefined
  if (!container || !containerLocator) return undefined
  const wanted = shortClass(target.class)
  const index = all
    .filter(
      (n) =>
        n.visible &&
        intersectsScreen(n.bounds, ctx.screen) &&
        classMatches(n.class, wanted) &&
        within(n, container),
    )
    .findIndex((n) => n.ref === target.ref)
  return index < 0 ? undefined : { class_index: { class: wanted, index, within: containerLocator } }
}

const round4 = (value: number) => Math.min(1, Math.max(0, Math.round(value * 10_000) / 10_000))

/**
 * The fallback chain the Recorder writes for `target` (SPEC §7.2, research R8.2–R8.4): id, text,
 * desc, `rel` to the nearest label, `class_index` in the nearest ancestor with an id — each kept
 * only when it resolves to exactly this element on this tree, so the first locator is right when
 * recording (SC-004) — then the `image` cut-out when given, and `point_pct` of the element's centre
 * last, only when no structural locator made it.
 */
export function extractLocators(
  target: ElementNode,
  tree: readonly ElementNode[],
  ctx: ResolveContext,
  options: LocatorOptions = {},
): Locator[] {
  const text = normalize(target.text)
  const desc = normalize(target.desc)
  const candidates: (Locator | undefined)[] = [
    idLocator(target, ctx),
    text && !isInput(target) ? { text } : undefined,
    desc ? { desc } : undefined,
    ...relLocators(target, tree, ctx),
    classIndexLocator(target, tree, ctx),
  ]
  const structural: Locator[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate) continue
    const key = JSON.stringify(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    if (resolve([candidate], tree, ctx)?.node?.ref === target.ref) structural.push(candidate)
  }
  const chain = [...structural]
  if (options.image) chain.push({ image: options.image })
  if (structural.length === 0) {
    const { x, y } = center(target.bounds)
    chain.push({ point_pct: [round4(x / ctx.screen.width), round4(y / ctx.screen.height)] })
  }
  return chain
}
