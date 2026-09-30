import { walkTree, type ElementNode } from '@coral/shared'
import { throwIfAborted, type Clock } from './clock'
import type { UiDriver } from './driver'

export const STABLE_INTERVAL_MS = 300
export const STABLE_TIMEOUT_MS = 3000

const round4 = (value: number) => Math.round(value / 4)

/**
 * Structure of a screen, ignoring text so clocks and counters do not count as changes
 * (§8.3, research R5): class, platform id and bounds rounded to 4 px.
 */
export function structureHash(tree: readonly ElementNode[]): string {
  const parts: string[] = []
  for (const node of walkTree(tree)) {
    const { x, y, w, h } = node.bounds
    parts.push(
      `${node.ref}|${node.class}|${node.platform_id}|${round4(x)},${round4(y)},${round4(w)},${round4(h)}`,
    )
  }
  return parts.join('\n')
}

export interface StableScreen {
  tree: ElementNode[]
  /** The screen kept changing until the timeout; the run goes on with the last tree. */
  unstable: boolean
}

/** Two dumps `intervalMs` apart with the same structure = stable; gives up after `timeoutMs`. */
export async function waitForStable(
  driver: Pick<UiDriver, 'tree'>,
  clock: Clock,
  options: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<StableScreen> {
  const interval = options.intervalMs ?? STABLE_INTERVAL_MS
  const timeout = options.timeoutMs ?? STABLE_TIMEOUT_MS
  const start = clock.now()
  let previous = await driver.tree()
  for (;;) {
    await clock.sleep(interval, options.signal)
    throwIfAborted(options.signal)
    const current = await driver.tree()
    if (structureHash(current) === structureHash(previous))
      return { tree: current, unstable: false }
    if (clock.now() - start >= timeout) return { tree: current, unstable: true }
    previous = current
  }
}
