import { walkTree, type ElementNode } from '@coral/shared'
import type { Point } from '../driver'
import { touchTargetAt } from '../hit-test'
import { contains } from '../locator/geometry'

const area = (node: ElementNode) => node.bounds.w * node.bounds.h

/**
 * The element a click at `point` is about when recording (FR-011, research R8.1): the node that
 * receives a tap there (D36) when it is clickable — a label inside a button gives the button, a
 * logo drawn over a menu lets the tap through to the menu. When the receiver is not clickable, the
 * smallest visible clickable node of its window that contains the point; when there is none either
 * (a click outside the app), the receiver itself: the window on top.
 */
export function pickTarget(tree: readonly ElementNode[], point: Point): ElementNode | undefined {
  const receiver = touchTargetAt(tree, point)
  if (!receiver || receiver.clickable) return receiver
  const window = tree.find((w) => receiver.ref === w.ref || receiver.ref.startsWith(`${w.ref}.`))
  let smallest: ElementNode | undefined
  for (const node of window ? walkTree([window]) : []) {
    if (!node.clickable || !node.visible || !contains(node.bounds, point)) continue
    if (!smallest || area(node) < area(smallest)) smallest = node
  }
  return smallest ?? receiver
}
