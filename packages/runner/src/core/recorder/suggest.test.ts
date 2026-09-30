import type { ElementNode } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { sampleApp, SAMPLE_APP } from '../../testing/sample-app'
import { expectFailure } from '../expect'
import type { ResolveContext } from '../locator/resolve'
import { suggestExpects } from './suggest'

const ctx: ResolveContext = {
  platform: 'android',
  screen: { width: 1080, height: 2400 },
  appId: SAMPLE_APP,
}
const screen = (name: string): ElementNode[] => sampleApp().screens[name]?.frames.at(-1) ?? []
const map = (tree: ElementNode[], edit: (n: ElementNode) => Partial<ElementNode>): ElementNode[] =>
  tree.map(function walk(n): ElementNode {
    return { ...n, ...edit(n), children: n.children.map(walk) }
  })

describe('suggestExpects (FR-013a, research R9)', () => {
  it('after logging in: the new title, a new element, the button that went away', () => {
    const suggestions = suggestExpects(screen('login'), screen('catalog'), ctx)
    expect(suggestions).toEqual([
      { visible_text: 'Products' },
      { visible: { android_id: 'id/productIV' } },
      { not_visible: { android_id: 'id/loginBtn' } },
    ])
    expect(expectFailure(suggestions, screen('catalog'), ctx)).toBeUndefined()
  })

  it('after opening the menu: its first item, the menu list, its second item', () => {
    expect(suggestExpects(screen('catalog'), screen('menu'), ctx)).toEqual([
      { visible_text: 'Catalog' },
      { visible: { android_id: 'id/menuRV' } },
      { visible_text: 'WebView' },
    ])
  })

  it('offers nothing when nothing new is on screen', () => {
    expect(suggestExpects(screen('catalog'), screen('catalog'), ctx)).toEqual([])
    // The clock ticked and a price changed: neither is worth waiting for.
    const later = map(screen('catalog'), (n) => ({
      text: n.text === '10:24' ? '10:25' : n.text === '$ 29.99' ? '$ 31.99' : n.text,
    }))
    expect(suggestExpects(screen('catalog'), later, ctx)).toEqual([])
  })

  it('never offers what was typed into a field (it may be a secret)', () => {
    const typed = map(screen('login'), (n) => ({
      text: n.platform_id.endsWith(':id/nameET') ? 'someone@example.io' : n.text,
    }))
    expect(suggestExpects(screen('login'), typed, ctx)).toEqual([])
  })

  it('ignores what another package shows (a permission dialog)', () => {
    expect(suggestExpects(screen('qr'), screen('qr_permission'), ctx)).toEqual([])
  })
})
