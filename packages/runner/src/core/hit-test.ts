import type { ElementNode } from '@coral/shared'
import type { Point } from './driver'
import { contains } from './locator/geometry'

const drawingOrder = (node: ElementNode) => node.android?.drawing_order ?? 0

function topmostIn(node: ElementNode, point: Point): ElementNode {
  // Among children under the point, the one drawn last is on top: highest drawing order,
  // then the later sibling.
  let best: ElementNode | undefined
  for (const child of node.children) {
    if (!child.visible || !contains(child.bounds, point)) continue
    if (!best || drawingOrder(child) >= drawingOrder(best)) best = child
  }
  return best ? topmostIn(best, point) : node
}

/**
 * The node that receives a tap at `point` (§8.4, research R5): the last window containing the
 * point, then within it the child drawn on top at each level, down to the deepest node.
 */
export function topNodeAt(tree: readonly ElementNode[], point: Point): ElementNode | undefined {
  for (let i = tree.length - 1; i >= 0; i -= 1) {
    const window = tree[i]
    if (window?.visible && contains(window.bounds, point)) return topmostIn(window, point)
  }
  return undefined
}

export type HitCheck = { ok: true } | { ok: false; covering?: ElementNode }

/** A tap is safe when the top node at the point is the target or inside its subtree. */
export function checkHit(
  tree: readonly ElementNode[],
  target: ElementNode,
  point: Point,
): HitCheck {
  const top = topNodeAt(tree, point)
  if (top && (top.ref === target.ref || top.ref.startsWith(`${target.ref}.`))) return { ok: true }
  return top ? { ok: false, covering: top } : { ok: false }
}
