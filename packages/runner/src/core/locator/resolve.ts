import {
  imageLocator,
  locatorPlatforms,
  walkTree,
  type Bounds,
  type ElementNode,
  type Locator,
  type Platform,
} from '@coral/shared'
import type { Point, Size } from '../driver'
import { classMatches } from './class-match'
import { center, intersectsScreen } from './geometry'
import { relDirection, relDistance } from './rel'

export interface ResolveContext {
  platform: Platform
  screen: Size
  /** Package / bundle id under test: expands `android_id: id/foo` to `<app>:id/foo`. */
  appId?: string
  /** App map screens the test case expects, id → fingerprint (`expect.screen`, D24). */
  screens?: Readonly<Record<string, string>>
  /** Foreground activity when the tree was read, part of the fingerprint. */
  activity?: string
}

export interface Resolution {
  /** Matched node; absent for `point_pct` and `image`. */
  node?: ElementNode
  /** `image`: the region of the screen that matched the picture (a virtual element). */
  bounds?: Bounds
  /** Where to act: always the centre of `node.bounds` read now, or the `point_pct` point (P2). */
  point: Point
  /** Index of the matching locator in the original target list. */
  index: number
  /** A later locator matched although an earlier applicable one exists (§8.7). */
  degraded: boolean
}

const normalize = (text: string) => text.trim().replace(/\s+/g, ' ')

interface Candidate {
  node: ElementNode
  order: number
  depth: number
}

function candidates(tree: readonly ElementNode[], ctx: ResolveContext): Candidate[] {
  let order = 0
  const out: Candidate[] = []
  for (const node of walkTree(tree)) {
    order += 1
    if (node.visible && intersectsScreen(node.bounds, ctx.screen)) {
      out.push({ node, order, depth: node.ref.split('.').length })
    }
  }
  return out
}

/** Tie-break: clickable first, then the deepest node, then dump order (research R4). */
function byPreference(a: Candidate, b: Candidate): number {
  return (
    Number(b.node.clickable) - Number(a.node.clickable) || b.depth - a.depth || a.order - b.order
  )
}

function isInside(node: ElementNode, ancestor: ElementNode): boolean {
  return node.ref.startsWith(`${ancestor.ref}.`)
}

function idMatches(platformId: string, wanted: string, ctx: ResolveContext): boolean {
  if (platformId === wanted) return true
  if (wanted.includes(':')) return false
  return ctx.appId ? platformId === `${ctx.appId}:${wanted}` : platformId.endsWith(`:${wanted}`)
}

/** Every visible node the locator matches, best first. `point_pct` and `image` match no node. */
export function findAll(
  locator: Locator,
  tree: readonly ElementNode[],
  ctx: ResolveContext,
  pool: Candidate[] = candidates(tree, ctx),
): ElementNode[] {
  const pick = (test: (n: ElementNode) => boolean) =>
    pool
      .filter((c) => test(c.node))
      .sort(byPreference)
      .map((c) => c.node)

  if (locator.android_id !== undefined) {
    if (ctx.platform !== 'android') return []
    const id = locator.android_id
    return pick((n) => idMatches(n.platform_id, id, ctx))
  }
  if (locator.ios_id !== undefined) {
    if (ctx.platform !== 'ios') return []
    const id = locator.ios_id
    return pick((n) => n.platform_id === id)
  }
  if (locator.text !== undefined) {
    const text = normalize(locator.text)
    return pick((n) => normalize(n.text) === text)
  }
  if (locator.text_contains !== undefined) {
    const part = normalize(locator.text_contains)
    return pick((n) => normalize(n.text).includes(part))
  }
  if (locator.desc !== undefined) {
    const desc = normalize(locator.desc)
    return pick((n) => normalize(n.desc) === desc)
  }
  if (locator.rel) {
    const direction = relDirection(locator.rel)
    const anchorLocator = direction ? locator.rel[direction] : undefined
    const anchor = anchorLocator ? findAll(anchorLocator, tree, ctx, pool)[0] : undefined
    if (!direction || !anchor) return []
    const wantedClass = locator.rel.class
    return pool
      .filter((c) => wantedClass === undefined || classMatches(c.node.class, wantedClass))
      .map((c) => ({ c, distance: relDistance(direction, anchor.bounds, c.node.bounds) }))
      .filter((x): x is { c: Candidate; distance: number } => x.distance !== undefined)
      .sort((a, b) => a.distance - b.distance || byPreference(a.c, b.c))
      .map((x) => x.c.node)
  }
  if (locator.class_index) {
    const { class: wanted, index, within } = locator.class_index
    const container = within ? findAll(within, tree, ctx, pool)[0] : undefined
    if (within && !container) return []
    const matches = pool
      .filter((c) => classMatches(c.node.class, wanted))
      .filter((c) => !container || isInside(c.node, container))
      .sort((a, b) => a.order - b.order)
    const hit = matches[index]
    return hit ? [hit.node] : []
  }
  return []
}

/** The node or point one locator gives, or undefined (`image` never matches here). */
function locate(
  locator: Locator,
  tree: readonly ElementNode[],
  ctx: ResolveContext,
  pool: Candidate[],
): Pick<Resolution, 'node' | 'point'> | undefined {
  if (locator.point_pct) {
    const [px, py] = locator.point_pct
    return {
      point: { x: Math.round(px * ctx.screen.width), y: Math.round(py * ctx.screen.height) },
    }
  }
  const node = findAll(locator, tree, ctx, pool)[0]
  return node ? { node, point: center(node.bounds) } : undefined
}

/**
 * Walks the fallback chain (§7.2): locators for other platforms are skipped; the first one that
 * matches wins. Returns undefined when nothing matches. `image` locators need a screenshot and
 * never match here; {@link resolveTarget} tries them.
 */
export function resolve(
  target: readonly Locator[],
  tree: readonly ElementNode[],
  ctx: ResolveContext,
): Resolution | undefined {
  const pool = candidates(tree, ctx)
  let applicable = 0
  for (const [index, locator] of target.entries()) {
    if (!locatorPlatforms(locator).includes(ctx.platform)) continue
    const degraded = applicable > 0
    applicable += 1
    const found = locate(locator, tree, ctx, pool)
    if (found) return { ...found, index, degraded }
  }
  return undefined
}

/** Finds an `image` locator's picture on the screen now: its bounds in device pixels, or none. */
export type ImageSearch = (image: ReturnType<typeof imageLocator>) => Promise<Bounds | undefined>

/**
 * {@link resolve} with `image` locators tried in their place in the chain (FR-021, research
 * R12): a match is a virtual element, the matched region; the tap goes to its centre.
 */
export async function resolveTarget(
  target: readonly Locator[],
  tree: readonly ElementNode[],
  ctx: ResolveContext,
  findImage?: ImageSearch,
): Promise<Resolution | undefined> {
  const pool = candidates(tree, ctx)
  let applicable = 0
  for (const [index, locator] of target.entries()) {
    if (!locatorPlatforms(locator).includes(ctx.platform)) continue
    const degraded = applicable > 0
    applicable += 1
    if (locator.image !== undefined) {
      const bounds = findImage ? await findImage(imageLocator(locator.image)) : undefined
      if (bounds) return { bounds, point: center(bounds), index, degraded }
      continue
    }
    const found = locate(locator, tree, ctx, pool)
    if (found) return { ...found, index, degraded }
  }
  return undefined
}
