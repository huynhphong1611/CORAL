import { walkTree, type ElementNode } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { APP, androidTree } from '../testing/android-fixtures'
import { el, windows } from '../testing/fake-driver'
import { checkHit, topNodeAt, touchTargetAt } from './hit-test'
import { center, contains } from './locator/geometry'

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

  it('detects a clickable bottom sheet drawn over the target (higher drawing order)', () => {
    const tree = androidTree('overlay-bottom-sheet')
    const checkout = byId(tree, 'cartBt')
    const sheet = byId(tree, 'design_bottom_sheet')
    sheet.clickable = true
    const result = checkHit(tree, checkout, center(checkout.bounds))
    expect(result.ok).toBe(false)
    expect(result.ok ? undefined : result.covering?.platform_id).toBe(
      `${APP}:id/design_bottom_sheet`,
    )
    // A sheet that takes no touches lets the tap through, as on the device.
    sheet.clickable = false
    expect(topNodeAt(tree, center(checkout.bounds))?.platform_id).not.toBe(`${APP}:id/cartBt`)
    expect(checkHit(tree, checkout, center(checkout.bounds))).toEqual({ ok: true })
  })

  it('ignores a non-clickable view drawn over a clickable one (logo over the menu icon)', () => {
    // My Demo App 2.3.0 on Android 14: the header logo id/mTvTitle overlaps id/menuIV.
    const tree = windows(
      APP,
      el({
        bounds: [0, 0, 1080, 2400],
        children: [
          el({
            platform_id: `${APP}:id/menuIV`,
            desc: 'View menu',
            clickable: true,
            bounds: [30, 110, 120, 120],
          }),
          el({ platform_id: `${APP}:id/mTvTitle`, bounds: [0, 100, 1080, 150] }),
        ],
      }),
    )
    const menu = byId(tree, 'menuIV')
    expect(topNodeAt(tree, center(menu.bounds))?.platform_id).toBe(`${APP}:id/mTvTitle`)
    expect(touchTargetAt(tree, center(menu.bounds))?.platform_id).toBe(`${APP}:id/menuIV`)
    expect(checkHit(tree, menu, center(menu.bounds))).toEqual({ ok: true })
  })

  it('accepts a label whose clickable row receives the tap', () => {
    const tree = windows(
      APP,
      el({
        bounds: [0, 0, 1080, 2400],
        children: [
          el({
            clickable: true,
            bounds: [0, 500, 1080, 120],
            children: [el({ text: 'Log In', bounds: [40, 520, 400, 80] })],
          }),
        ],
      }),
    )
    const label = [...walkTree(tree)].find((n) => n.text === 'Log In')
    if (!label) throw new Error('no label')
    expect(checkHit(tree, label, center(label.bounds))).toEqual({ ok: true })
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

  it('lets a dialog window take taps outside its bounds, but not the keyboard or status bar', () => {
    // The dialog window has the dialog's size (as on the device); the app's toolbar is outside it.
    for (const file of ['rate-app-dialog', 'permission-dialog', 'crash-dialog']) {
      const tree = androidTree(file)
      const dialog = tree.at(-2) as ElementNode
      expect(dialog.bounds.h).toBeLessThan(2400)
      const app = [...walkTree(tree)].find(
        (n) =>
          n.package_or_bundle === APP &&
          n.clickable &&
          n.visible &&
          !contains(dialog.bounds, center(n.bounds)),
      )
      if (!app) throw new Error(`no app node outside the dialog in ${file}`)
      const result = checkHit(tree, app, center(app.bounds))
      expect(result.ok ? undefined : result.covering?.ref, file).toBe(dialog.ref)
      // What is drawn there is still the app.
      expect(topNodeAt(tree, center(app.bounds))?.package_or_bundle, file).toBe(APP)
    }
    const status = androidTree('login').at(-1) as ElementNode
    expect(touchTargetAt(androidTree('login'), { x: 540, y: 1200 })?.package_or_bundle).toBe(APP)
    expect(status.package_or_bundle).toBe('com.android.systemui')
  })

  it('returns undefined outside every window', () => {
    expect(topNodeAt(androidTree('login'), { x: 5000, y: 5000 })).toBeUndefined()
  })
})
