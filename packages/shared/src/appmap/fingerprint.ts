import { walkTree, type ElementNode } from '../element'
import { sha256Hex } from './sha256'

/** Windows that never belong to the screen of the app under test (status bar, keyboards). */
const SYSTEM_PACKAGE = /^(com\.android\.systemui|android)$|inputmethod|\.ime$|keyboard/i

const shortClass = (name: string) => name.slice(name.lastIndexOf('.') + 1)

export interface FingerprintContext {
  /** The app under test: only its windows count (all non-system windows when absent). */
  package?: string
  /** The resumed activity, when the platform tells (Android `dumpsys`). */
  activity?: string
}

/**
 * Fingerprint of a screen (SPEC §10, D24): the hash of the app's activity and the sorted set of
 * `(short class, platform id)` pairs of its structural elements — those with an id, or that take a
 * tap. Text and bounds are ignored, and so is how often a pair repeats, so the same screen with
 * other data (a clock, a longer list, other product names) keeps its fingerprint. Used by the
 * Explorer for the app map and by the runner for `expect.screen`. 16 hex characters.
 *
 * Known limit: an element with an id that only appears after scrolling (a footer) changes the
 * set; the Explorer records such a screen twice rather than merging two different screens.
 */
export function screenFingerprint(
  tree: readonly ElementNode[],
  context: FingerprintContext = {},
): string {
  const windows = tree.filter((window) =>
    context.package
      ? window.package_or_bundle === context.package
      : !SYSTEM_PACKAGE.test(window.package_or_bundle),
  )
  const pairs = new Set<string>()
  for (const node of walkTree(windows)) {
    if (!node.visible) continue
    if (node.platform_id === '' && !node.clickable) continue
    pairs.add(`${shortClass(node.class)}|${node.platform_id}`)
  }
  const key = [context.package ?? '', context.activity ?? '', ...[...pairs].sort()].join('\n')
  return sha256Hex(key).slice(0, 16)
}
