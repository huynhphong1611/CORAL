import { APP, androidTree } from '@coral/runner/testing'
import { describe, expect, it } from 'vitest'
import { elementKey, isSearchField, serializeScreen, type ScreenContext } from './screen'

const ctx: ScreenContext = {
  appPackage: APP,
  screen: { width: 1080, height: 2400 },
  neverTap: [],
  forbidden: [],
  secrets: {},
}
const ids = (name: string, extra: Partial<ScreenContext> = {}) =>
  serializeScreen(androidTree(name), { ...ctx, ...extra }).input.elements.map((e) => e.id ?? e.desc)

describe('serializeScreen (research R6, contracts/brain.md §2)', () => {
  it('numbers the actionable elements of the app in reading order with their flags', () => {
    const { input, elements } = serializeScreen(androidTree('login'), ctx)
    expect(input.elements.map((e) => [e.n, e.id, e.flags])).toEqual([
      // The scrollable form: the AI may swipe it.
      [1, 'content', ['new', 'scroll']],
      [2, 'nameET', ['new', 'field']],
      [3, 'passwordET', ['new', 'field', 'password']],
      [4, 'loginBtn', ['new']],
      [5, 'forgotTV', ['new']],
      [6, 'tab_catalog', ['new']],
      [7, 'tab_cart', ['new']],
      [8, 'tab_menu', ['new']],
      [9, 'tab_profile', ['new']],
    ])
    // The status bar is never listed; labels and bounds come with each element.
    expect(input.elements[3]).toMatchObject({ className: 'Button', text: 'Login' })
    expect(elements[3]?.locators[0]).toEqual({ android_id: 'id/loginBtn' })
    expect(input.visibleTexts.map((t) => t.text)).toContain('Forgot password?')
    expect(input.visibleTexts.map((t) => t.text)).not.toContain('10:24')
    // The same tree gives the same list.
    expect(serializeScreen(androidTree('login'), ctx).input).toEqual(input)
  })

  it('leaves out elements another element covers (D36)', () => {
    const listed = ids('overlay-bottom-sheet')
    expect(listed.join(' ')).not.toMatch(/checkout/i)
    expect(
      serializeScreen(androidTree('overlay-bottom-sheet'), ctx).input.elements.map((e) => e.text),
    ).toContain('Đóng')
    // Under the keyboard: the bottom tabs; the login button above it stays.
    const withKeyboard = ids('keyboard-open')
    expect(withKeyboard).toContain('loginBtn')
    expect(withKeyboard).not.toContain('tab_catalog')
  })

  it('never lists never_tap buttons nor elements a skill forbids', () => {
    const dialog = serializeScreen(androidTree('never-tap-only-dialog'), {
      ...ctx,
      neverTap: ['mua', 'Thanh  toán'],
    })
    const texts = dialog.input.elements.map((e) => e.text)
    expect(texts).not.toContain('Mua')
    expect(texts).not.toContain('Thanh toán')
    expect(dialog.excluded.map((x) => [x.node.text, x.reason])).toEqual([
      ['Mua', 'never_tap'],
      ['Thanh toán', 'never_tap'],
    ])
    // Named to the AI, so that a goal needing one is known unreachable (US5).
    expect(dialog.input.forbidden).toEqual(['Mua', 'Thanh toán'])
    const login = serializeScreen(androidTree('login'), {
      ...ctx,
      forbidden: [{ android_id: 'id/loginBtn' }],
    })
    expect(login.input.elements.map((e) => e.id)).not.toContain('loginBtn')
    expect(login.excluded).toMatchObject([{ reason: 'skill_forbidden' }])
    // Numbers stay consecutive.
    expect(login.input.elements.map((e) => e.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('shows secret values as ${secret:NAME}', () => {
    const { input } = serializeScreen(androidTree('login'), {
      ...ctx,
      secrets: { TEST_USER: 'bob@example.com' },
    })
    const all = JSON.stringify(input)
    expect(all).not.toContain('bob@example.com')
    expect(input.visibleTexts.map((t) => t.text)).toContain('${secret:TEST_USER}')
  })

  it('marks what the frontier already tried or found dead', () => {
    const first = serializeScreen(androidTree('login'), ctx)
    const login = first.elements[3]?.key ?? ''
    const forgot = first.elements[4]?.key ?? ''
    expect(login).toBe(elementKey([{ android_id: 'id/loginBtn' }]))
    const again = serializeScreen(androidTree('login'), {
      ...ctx,
      tried: new Set([login]),
      dead: new Set([forgot]),
    })
    expect(again.input.elements[3]?.flags).toEqual(['tried'])
    expect(again.input.elements[4]?.flags).toEqual(['dead'])
  })

  it('lists permission dialog buttons, not the app under a modal dialog', () => {
    const listed = serializeScreen(androidTree('permission-dialog'), ctx).input.elements
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.every((e) => e.id?.startsWith('permission_') ?? false)).toBe(true)
  })

  it('caps the list at 80 elements', () => {
    const { input } = serializeScreen(androidTree('list-scroll'), ctx)
    expect(input.elements.length).toBeLessThanOrEqual(80)
  })
})

describe('isSearchField', () => {
  it('knows search boxes by class, id, hint or description', () => {
    const node = (over: object) => ({
      ref: '0',
      platform_id: '',
      text: '',
      desc: '',
      class: 'android.widget.EditText',
      bounds: { x: 0, y: 0, w: 10, h: 10 },
      clickable: true,
      enabled: true,
      visible: true,
      package_or_bundle: APP,
      children: [],
      ...over,
    })
    expect(isSearchField(node({ class: 'android.widget.SearchView$SearchAutoComplete' }))).toBe(
      true,
    )
    expect(isSearchField(node({ platform_id: `${APP}:id/searchET` }))).toBe(true)
    expect(isSearchField(node({ desc: 'Tìm sản phẩm' }))).toBe(true)
    expect(isSearchField(node({ text: 'Filter products' }))).toBe(true)
    expect(isSearchField(node({ platform_id: `${APP}:id/nameET` }))).toBe(false)
  })
})
