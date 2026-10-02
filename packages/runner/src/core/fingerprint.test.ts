import { screenFingerprint, walkTree, type ElementNode } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { androidTree, APP } from '../testing/android-fixtures'

// The shared fingerprint (D24) on real UiAutomator dumps: the runner uses it for expect.screen.
const ctx = { package: APP }

/** The same dump with every text changed and the lists cut to two rows. */
function otherData(tree: ElementNode[]): ElementNode[] {
  const clone = structuredClone(tree)
  for (const node of walkTree(clone)) {
    if (node.text) node.text = `${node.text} (changed)`
    if (/RecyclerView|ListView/.test(node.class)) node.children = node.children.slice(0, 2)
  }
  return clone
}

describe('screenFingerprint on Android fixtures', () => {
  it('keeps a screen whose data changed', () => {
    for (const name of ['list-scroll', 'login']) {
      const tree = androidTree(name)
      expect(screenFingerprint(otherData(tree), ctx), name).toBe(screenFingerprint(tree, ctx))
    }
  })

  it('tells the catalog, the login form and a dialog apart', () => {
    const prints = ['list-scroll', 'login', 'permission-dialog'].map((name) =>
      screenFingerprint(androidTree(name), ctx),
    )
    expect(new Set(prints).size).toBe(3)
  })

  it('does not change when the keyboard opens over the same screen', () => {
    const open = androidTree('keyboard-open')
    const closed = open.filter((w) => !w.package_or_bundle.includes('inputmethod'))
    expect(screenFingerprint(open, ctx)).toBe(screenFingerprint(closed, ctx))
  })
})
