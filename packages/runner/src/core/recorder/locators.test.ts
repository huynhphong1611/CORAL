import { walkTree, type ElementNode } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { ANDROID_FIXTURES, APP, androidTree } from '../../testing/android-fixtures'
import { el, windows } from '../../testing/fake-driver'
import { sampleApp } from '../../testing/sample-app'
import { intersectsScreen } from '../locator/geometry'
import { resolve, type ResolveContext } from '../locator/resolve'
import { extractLocators } from './locators'

const ctx: ResolveContext = {
  platform: 'android',
  screen: { width: 1080, height: 2400 },
  appId: APP,
}
const id = (name: string) => `${APP}:id/${name}`
const image = { path: 'snap/rec/s1/element.png', screen_width: 1080 }
const node = (tree: ElementNode[], platformId: string) => {
  const found = [...walkTree(tree)].find((n) => n.platform_id === platformId)
  if (!found) throw new Error(`no ${platformId}`)
  return found
}

describe('extractLocators (SPEC §7.2, research R8)', () => {
  it('writes id, text, rel and class_index for a button, then its image', () => {
    const login = androidTree('login')
    expect(extractLocators(node(login, id('loginBtn')), login, ctx, { image })).toEqual([
      { android_id: 'id/loginBtn' },
      // The title "Login" is a TextView too, but a tap goes to the clickable button first.
      { text: 'Login' },
      { rel: { below: { text: 'Mật khẩu' }, class: 'Button' } },
      { class_index: { class: 'Button', index: 0, within: { android_id: 'id/content' } } },
      { image },
    ])
  })

  it('never writes the text of an input (its content, maybe a secret)', () => {
    const login = androidTree('login')
    const typed = login.map(function fill(n): ElementNode {
      return {
        ...n,
        text: n.platform_id === id('passwordET') ? '••••••' : n.text,
        children: n.children.map(fill),
      }
    })
    const password = extractLocators(node(typed, id('passwordET')), typed, ctx)
    expect(password.some((l) => l.text !== undefined)).toBe(false)
    expect(password[0]).toEqual({ android_id: 'id/passwordET' })
    expect(extractLocators(node(login, id('nameET')), login, ctx)).toEqual([
      { android_id: 'id/nameET' },
      { desc: 'Tên đăng nhập' },
      { rel: { below: { text: 'Username' }, class: 'EditText' } },
      { class_index: { class: 'EditText', index: 0, within: { android_id: 'id/content' } } },
    ])
  })

  it('drops locators that find another element first', () => {
    // Every tab icon has the id tab_icon; the Menu tab has the label "bob@example.com" above it,
    // but so do the other tabs, and the Catalog tab comes first.
    const login = androidTree('login')
    const menu = extractLocators(node(login, id('tab_menu')), login, ctx)
    expect(menu).toEqual([
      { android_id: 'id/tab_menu' },
      { desc: 'Menu' },
      { class_index: { class: 'FrameLayout', index: 2, within: { android_id: 'id/bottom_nav' } } },
    ])
  })

  it('anchors rel on a label of the same window, never the status bar clock', () => {
    const catalog = sampleApp().screens.catalog?.frames.at(-1) ?? []
    expect(extractLocators(node(catalog, id('menuIV')), catalog, ctx)).toEqual([
      { android_id: 'id/menuIV' },
      { desc: 'View menu' },
    ])
    // The second product card has no id or text of its own: the title of the first, on its left.
    const cards = [...walkTree(catalog)].filter((n) => n.platform_id === id('productIV'))
    const second = cards[1]
    if (!second) throw new Error('no second card')
    expect(extractLocators(second, catalog, ctx, { image })).toEqual([
      { rel: { right_of: { text: 'Sauce Labs Backpack' }, class: 'ViewGroup' } },
      { image },
    ])
  })

  it('keeps the full id of another package (a system dialog button)', () => {
    const dialog = androidTree('permission-dialog')
    const allowId =
      'com.google.android.permissioncontroller:id/permission_allow_foreground_only_button'
    const [first, second] = extractLocators(node(dialog, allowId), dialog, ctx)
    expect(first).toEqual({ android_id: allowId })
    expect(second).toEqual({ text: 'While using the app' })
  })

  it('ends with point_pct only when nothing structural finds the element', () => {
    const tree = windows(
      APP,
      el({
        bounds: [0, 0, 1080, 2400],
        children: [
          el({ clickable: true, bounds: [0, 600, 540, 600] }),
          el({ clickable: true, bounds: [540, 600, 540, 600] }),
        ],
      }),
    )
    const right = tree[0]?.children[1]
    if (!right) throw new Error('no node')
    expect(extractLocators(right, tree, ctx, { image })).toEqual([
      { image },
      { point_pct: [0.75, 0.375] },
    ])
  })

  // SC-004: every clickable element on every fixture screen gets at least two locators, and the
  // first one finds exactly that element.
  const screens: [string, ElementNode[]][] = [
    ...ANDROID_FIXTURES.map((file): [string, ElementNode[]] => [
      file,
      androidTree(file.replace(/\.xml$/, '')),
    ]),
    ...Object.entries(sampleApp().screens).map(([name, screen]): [string, ElementNode[]] => [
      `sample-app ${name}`,
      screen.frames.at(-1) ?? [],
    ]),
  ]
  it.each(screens)('SC-004 on %s', (_name, tree) => {
    const clickable = [...walkTree(tree)].filter(
      (n) => n.clickable && n.visible && intersectsScreen(n.bounds, ctx.screen),
    )
    expect(clickable.length).toBeGreaterThan(0)
    for (const target of clickable) {
      const chain = extractLocators(target, tree, ctx, { image })
      expect(chain.length, target.ref).toBeGreaterThanOrEqual(2)
      const first = chain[0]
      if (!first) throw new Error('empty chain')
      if (first.image) continue // nothing structural: image, then point_pct
      expect(resolve([first], tree, ctx)?.node?.ref, JSON.stringify(first)).toBe(target.ref)
    }
  })
})
