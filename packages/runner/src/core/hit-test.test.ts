import { walkTree, type ElementNode } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { APP, androidTree } from '../testing/android-fixtures'
import { checkHit, topNodeAt } from './hit-test'
import { center } from './locator/geometry'

const byId = (tree: ElementNode[], suffix: string) => {
  const node = [...walkTree(tree)].find((n) => n.platform_id === `${APP}:id/${suffix}`)
  if (!node) throw new Error(`no ${suffix}`)
  return node
}

describe('hit-test', () => {
  it('lets a tap through when the target is on top (or its child is)', () => {
    const login = androidTree('login')
    const button = byId(login, 'loginBtn')
    expect(checkHit(login, button, center(button.bounds))).toEqual({ ok: true })
    const tab = byId(login, 'tab_profile')
    // The centre of the tab is its icon: a child of the target still counts.
    expect(topNodeAt(login, center(tab.bounds))?.platform_id).toBe(`${APP}:id/tab_icon`)
    expect(checkHit(login, tab, center(tab.bounds))).toEqual({ ok: true })
  })

  it('detects a bottom sheet drawn over the target (higher drawing order)', () => {
    const tree = androidTree('overlay-bottom-sheet')
    const checkout = byId(tree, 'cartBt')
    const result = checkHit(tree, checkout, center(checkout.bounds))
    expect(result.ok).toBe(false)
    expect(result.ok ? undefined : result.covering?.platform_id).toBe(`${APP}:id/design_bottom_sheet`)
  })

  it('detects the keyboard window over the bottom navigation', () => {
    const tree = androidTree('keyboard-open')
    const tab = byId(tree, 'tab_profile')
    const result = checkHit(tree, tab, center(tab.bounds))
    expect(result.ok ? undefined : result.covering?.package_or_bundle).toBe(
      'com.google.android.inputmethod.latin',
    )
    const button = byId(tree, 'loginBtn')
    expect(checkHit(tree, button, center(button.bounds))).toEqual({ ok: true })
  })

  it('treats a system dialog window as covering the app', () => {
    const tree = androidTree('permission-dialog')
    expect(topNodeAt(tree, { x: 540, y: 1200 })?.package_or_bundle).toMatch(/permissioncontroller/)
  })

  it('returns undefined outside every window', () => {
    expect(topNodeAt(androidTree('login'), { x: 5000, y: 5000 })).toBeUndefined()
  })
})
