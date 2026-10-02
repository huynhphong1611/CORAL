import { screenFingerprint } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { APP, androidTree } from '../testing/android-fixtures'
import { FakeClock } from '../testing/fake-clock'
import { FakeDriver } from '../testing/fake-driver'
import { checkExpect, expectFailure } from './expect'
import type { ResolveContext } from './locator/resolve'

const ctx: ResolveContext = {
  platform: 'android',
  screen: { width: 1080, height: 2400 },
  appId: APP,
}
const login = androidTree('login')
const list = androidTree('list-scroll')

describe('expect conditions', () => {
  it('visible_text matches visible text (contains, case-sensitive)', () => {
    expect(expectFailure([{ visible_text: 'Forgot password' }], login, ctx)).toBeUndefined()
    expect(expectFailure([{ visible_text: 'forgot password' }], login, ctx)).toMatch(/not visible/)
    // Off-screen / not visible-to-user items do not count.
    expect(expectFailure([{ visible_text: 'Sauce Labs Item 9' }], list, ctx)).toMatch(/not visible/)
  })

  it('visible accepts one locator or a list where any may match', () => {
    expect(expectFailure([{ visible: { android_id: 'id/loginBtn' } }], login, ctx)).toBeUndefined()
    expect(
      expectFailure([{ visible: [{ ios_id: 'x' }, { desc: 'Profile' }] }], login, ctx),
    ).toBeUndefined()
    expect(expectFailure([{ visible: { text: 'Nope' } }], login, ctx)).toMatch(/not visible/)
  })

  it('not_visible fails while any locator matches', () => {
    expect(expectFailure([{ not_visible: { text: 'Products' } }], login, ctx)).toBeUndefined()
    expect(
      expectFailure([{ not_visible: [{ text: 'Nope' }, { text: 'Login' }] }], login, ctx),
    ).toMatch(/still visible/)
  })

  it('needs every condition of the list at once', () => {
    const both = [{ visible_text: 'Login' }, { not_visible: { text: 'Login' } }]
    expect(expectFailure(both, login, ctx)).toMatch(/still visible/)
  })
})

describe('checkExpect', () => {
  it('polls every 250 ms until the screen changes', async () => {
    const driver = new FakeDriver({
      screens: { a: { frames: [list, list, list, login] } },
      start: 'a',
    })
    const clock = new FakeClock()
    const result = await checkExpect([{ visible_text: 'Forgot password?' }], driver, clock, ctx)
    expect(result.ok).toBe(true)
    expect(clock.sleeps).toEqual([250, 250, 250])
  })

  it('fails after the longest timeout of the list (default 5000 ms)', async () => {
    const driver = new FakeDriver({ screens: { a: { frames: [login] } }, start: 'a' })
    const clock = new FakeClock()
    const result = await checkExpect([{ visible_text: 'Products' }], driver, clock, ctx)
    expect(result).toMatchObject({ ok: false, message: 'text "Products" is not visible' })
    expect(clock.now()).toBe(5000)

    const slow = new FakeClock()
    await checkExpect(
      [
        { visible_text: 'Products', timeout_ms: 1000 },
        { visible_text: 'Login', timeout_ms: 8000 },
      ],
      driver,
      slow,
      ctx,
    )
    expect(slow.now()).toBe(8000)
  })
})

describe('expect.screen (D24, FR-023)', () => {
  const loginPrint = screenFingerprint(login, { package: APP, activity: '.a' })
  const screens = { 'dang-nhap': loginPrint }

  it('compares the fingerprint of the screen with the app map screen it names', () => {
    const at = { ...ctx, screens, activity: '.a' }
    expect(expectFailure([{ screen: 'dang-nhap' }], login, at)).toBeUndefined()
    expect(expectFailure([{ screen: 'dang-nhap' }], list, at)).toMatch(
      /screen "dang-nhap" is not shown \(fingerprint [0-9a-f]{16}, expected [0-9a-f]{16}\)/,
    )
    // Another activity is another screen, even with the same elements.
    expect(expectFailure([{ screen: 'dang-nhap' }], login, { ...at, activity: '.b' })).toMatch(
      /is not shown/,
    )
    expect(expectFailure([{ screen: 'gio-hang' }], login, at)).toBe(
      'screen "gio-hang" is not in the app map',
    )
  })

  it('reads the foreground activity with each tree and waits for the screen', async () => {
    const driver = new FakeDriver({ screens: { a: { frames: [list, list, login] } }, start: 'a' })
    driver.show('a')
    const clock = new FakeClock()
    const result = await checkExpect([{ screen: 'dang-nhap' }], driver, clock, { ...ctx, screens })
    expect(result.ok).toBe(true)
    expect(clock.sleeps).toEqual([250, 250])
  })

  it('ignores the activity of another app (a permission dialog)', async () => {
    const plain = screenFingerprint(login, { package: APP })
    const driver = new FakeDriver({ screens: { a: { frames: [login] } }, start: 'a' })
    driver.foregroundActivity = () =>
      Promise.resolve({ package: 'com.google.android.permissioncontroller', activity: '.Grant' })
    const result = await checkExpect([{ screen: 'login' }], driver, new FakeClock(), {
      ...ctx,
      screens: { login: plain },
    })
    expect(result.ok).toBe(true)
  })
})
