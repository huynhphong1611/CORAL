import type { ElementNode, Locator } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { APP, androidTree } from '../../testing/android-fixtures'
import { classMatches } from './class-match'
import { findAll, resolve, type ResolveContext } from './resolve'

const ctx: ResolveContext = {
  platform: 'android',
  screen: { width: 1080, height: 2400 },
  appId: APP,
}
const login = androidTree('login')
const id = (suffix: string) => `${APP}:id/${suffix}`
const resolveIn = (tree: ElementNode[], target: Locator[], c: ResolveContext = ctx) =>
  resolve(target, tree, c)

describe('classMatches', () => {
  it('accepts the short or the full class name', () => {
    expect(classMatches('android.widget.Button', 'Button')).toBe(true)
    expect(classMatches('android.widget.Button', 'android.widget.Button')).toBe(true)
    expect(classMatches('android.widget.Button', 'widget.Button')).toBe(false)
    expect(classMatches('android.widget.ImageButton', 'Button')).toBe(false)
  })
})

// SC-004: every locator type matches on a fixture, and falls through to the next when it does not.
describe('resolve (fixtures/android/login.xml)', () => {
  it.each<[string, Locator, string]>([
    ['android_id (full)', { android_id: id('loginBtn') }, id('loginBtn')],
    ['android_id (id/ shorthand)', { android_id: 'id/passwordET' }, id('passwordET')],
    ['text', { text: 'Forgot password?' }, id('forgotTV')],
    ['text_contains', { text_contains: 'example.com' }, ''],
    ['desc', { desc: 'Tên đăng nhập' }, id('nameET')],
    [
      'rel below + class',
      { rel: { below: { text: 'Mật khẩu' }, class: 'Button' } },
      id('loginBtn'),
    ],
    ['rel below, nearest', { rel: { below: { text: 'Mật khẩu' } } }, id('passwordET')],
    [
      'rel above',
      { rel: { above: { android_id: 'id/passwordET' }, class: 'EditText' } },
      id('nameET'),
    ],
    [
      'class_index within',
      { class_index: { class: 'FrameLayout', index: 3, within: { android_id: 'id/bottom_nav' } } },
      id('tab_profile'),
    ],
  ])('matches %s', (_name, locator, platformId) => {
    const result = resolveIn(login, [locator])
    expect(result?.node?.platform_id).toBe(platformId)
    expect(result?.index).toBe(0)
    expect(result?.degraded).toBe(false)
  })

  it.each<[string, Locator]>([
    ['android_id', { android_id: 'id/missing' }],
    ['text (case-sensitive)', { text: 'forgot password?' }],
    ['text_contains', { text_contains: 'nowhere' }],
    ['desc', { desc: 'Nope' }],
    ['rel with missing anchor', { rel: { below: { text: 'Missing' } } }],
    ['rel with no candidate', { rel: { above: { text: 'Login' }, class: 'Button' } }],
    [
      'class_index out of range',
      { class_index: { class: 'FrameLayout', index: 9, within: { android_id: 'id/bottom_nav' } } },
    ],
    ['image (Phase 2)', { image: 'snap/x.png' }],
  ])('falls back when %s does not match (degraded)', (_name, locator) => {
    const result = resolveIn(login, [locator, { desc: 'Profile' }])
    expect(result).toMatchObject({ index: 1, degraded: true })
    expect(result?.node?.platform_id).toBe(id('tab_profile'))
  })

  it('taps the centre of bounds read now', () => {
    expect(resolveIn(login, [{ android_id: 'id/loginBtn' }])?.point).toEqual({ x: 540, y: 990 })
  })

  it('uses point_pct only as the last resort', () => {
    const result = resolveIn(login, [{ text: 'Missing' }, { point_pct: [0.5, 0.25] }])
    expect(result).toEqual({ point: { x: 540, y: 600 }, index: 1, degraded: true })
  })

  it('prefers the clickable node, then the deepest one', () => {
    // "Login" is both a TextView title and the clickable button.
    expect(resolveIn(login, [{ text: 'Login' }])?.node?.platform_id).toBe(id('loginBtn'))
    expect(findAll({ text: 'Login' }, login, ctx).map((n) => n.platform_id)).toEqual([
      id('loginBtn'),
      id('loginTV'),
    ])
  })

  it('skips locators of other platforms without marking degraded', () => {
    const result = resolveIn(login, [{ ios_id: 'loginButton' }, { android_id: 'id/loginBtn' }])
    expect(result).toMatchObject({ index: 1, degraded: false })
  })

  it('matches id shorthand of any package without an app id', () => {
    const noApp: ResolveContext = { platform: 'android', screen: ctx.screen }
    expect(resolveIn(login, [{ android_id: 'id/clock' }], noApp)?.node?.text).toBe('10:24')
  })

  it('normalizes whitespace in text', () => {
    expect(resolveIn(login, [{ text: '  Forgot   password? ' }])?.node).toBeDefined()
  })

  it('returns undefined when nothing matches', () => {
    expect(resolveIn(login, [{ text: 'Missing' }, { desc: 'Missing' }])).toBeUndefined()
  })
})

describe('resolve (visibility)', () => {
  const list = androidTree('list-scroll')

  it('ignores nodes not visible to the user or off screen', () => {
    expect(resolveIn(list, [{ text: 'Sauce Labs Item 9' }])).toBeUndefined()
    expect(resolveIn(list, [{ text: 'Sauce Labs Item 1' }])?.node).toBeDefined()
  })
})
