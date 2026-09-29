import type { ElementNode } from '@coral/shared'
import type { Point } from './driver'
import { contains } from './locator/geometry'

const drawingOrder = (node: ElementNode) => node.android?.drawing_order ?? 0

/** Visible children under the point, the one drawn on top first (drawing order, then later sibling). */
function childrenUnder(node: ElementNode, point: Point): ElementNode[] {
  return node.children
    .map((child, index) => ({ child, index }))
    .filter(({ child }) => child.visible && contains(child.bounds, point))
    .sort((a, b) => drawingOrder(b.child) - drawingOrder(a.child) || b.index - a.index)
    .map(({ child }) => child)
}

function topmostIn(node: ElementNode, point: Point): ElementNode {
  const top = childrenUnder(node, point)[0]
  return top ? topmostIn(top, point) : node
}

/** The window a tap at `point` lands in: the last (topmost) visible window containing it. */
function windowAt(tree: readonly ElementNode[], point: Point): ElementNode | undefined {
  for (let i = tree.length - 1; i >= 0; i -= 1) {
    const window = tree[i]
    if (window?.visible && contains(window.bounds, point)) return window
  }
  return undefined
}

/** The node drawn on top at `point`: topmost window, then the child drawn last at each level. */
export function topNodeAt(tree: readonly ElementNode[], point: Point): ElementNode | undefined {
  const window = windowAt(tree, point)
  return window ? topmostIn(window, point) : undefined
}

/**
 * Android touch dispatch inside one window: children under the point are offered the touch from
 * the one drawn on top down; a subtree with nothing clickable lets it through to the next one.
 */
function receiverIn(node: ElementNode, point: Point): ElementNode | undefined {
  for (const child of childrenUnder(node, point)) {
    const receiver = receiverIn(child, point)
    if (receiver) return receiver
  }
  return node.clickable ? node : undefined
}

/**
 * The node that receives a tap at `point` (§8.4, research R5): in the topmost window containing
 * the point, the first clickable node in touch-dispatch order; the window itself when nothing in
 * it is clickable there (a window on top always takes the touch — keyboard, dialog, popup).
 */
export function touchTargetAt(tree: readonly ElementNode[], point: Point): ElementNode | undefined {
  const window = windowAt(tree, point)
  return window ? (receiverIn(window, point) ?? window) : undefined
}

export type HitCheck = { ok: true } | { ok: false; covering?: ElementNode }

const related = (a: ElementNode, b: ElementNode) =>
  a.ref === b.ref || a.ref.startsWith(`${b.ref}.`) || b.ref.startsWith(`${a.ref}.`)

/**
 * A tap is safe when the node receiving it is the target, inside the target, or contains it (a
 * label inside a clickable row). Non-clickable decorations drawn over the target do not block it,
 * as on the device; a clickable overlay or another window does.
 */
export function checkHit(
  tree: readonly ElementNode[],
  target: ElementNode,
  point: Point,
): HitCheck {
  const receiver = touchTargetAt(tree, point)
  if (receiver && related(receiver, target)) return { ok: true }
  return receiver ? { ok: false, covering: receiver } : { ok: false }
}
