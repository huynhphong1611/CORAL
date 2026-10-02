import { readFileSync } from 'node:fs'
import {
  DEFAULT_POPUPS_YAML,
  parseYaml,
  popupsSchema,
  validateTestCaseSource,
  walkTree,
} from '@coral/shared'
import { decode } from 'fast-png'
import { describe, expect, it } from 'vitest'
import { createPopupGuard } from '../core/popup-guard'
import { runTestCase } from '../core/run-testcase'
import { FakeClock } from './fake-clock'
import { FakeDriver } from './fake-driver'
import { renderTree } from './render'
import {
  INJECTION_TEXT,
  LOGIN_ERROR,
  PLACE_ORDER,
  SAMPLE_APP,
  SAMPLE_OTP,
  SAMPLE_PASSWORD,
  sampleApp,
} from './sample-app'

const fixture = (name: string) => {
  const source = readFileSync(
    new URL(`../../../../fixtures/testcases/${name}.yaml`, import.meta.url),
    'utf8',
  )
  const parsed = validateTestCaseSource(source, name)
  if (!parsed.value) throw new Error(JSON.stringify(parsed.errors))
  return parsed.value
}

async function run(name: string) {
  const driver = new FakeDriver({ ...sampleApp(), showTyped: true })
  const popups = popupsSchema.parse(parseYaml(DEFAULT_POPUPS_YAML).value)
  const result = await runTestCase({
    driver,
    testCase: fixture(name),
    appId: SAMPLE_APP,
    secrets: { TEST_USER: 'bod@example.com', TEST_PASSWORD: '10203040' },
    popupGuard: createPopupGuard({ popups, driver }),
    clock: new FakeClock(),
  })
  return { driver, result }
}

describe('sample app (My Demo App look-alike)', () => {
  it('passes fixtures/testcases/mydemo-login.yaml like the real app', async () => {
    const { driver, result } = await run('mydemo-login')
    expect(result.status, JSON.stringify(result.steps.at(-1))).toBe('passed')
    expect(result.steps.map((s) => s.step_id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7'])
    // Structured locators match: no fallbacks needed.
    expect(result.steps.filter((s) => s.degraded)).toEqual([])
    expect(driver.current).toBe('catalog_in')
    // What was typed stays in the login form: refs are index paths, the catalog has the same
    // ones, and its screenshots must not show the password (SC-008).
    const texts = [...walkTree(await driver.tree())].map((n) => n.text)
    expect(texts).not.toContain('10203040')
    expect(texts).not.toContain('bod@example.com')
    driver.show('login')
    const form = [...walkTree(await driver.tree())].map((n) => n.text)
    expect(form).toContain('bod@example.com')
  })

  it('passes mydemo-camera-permission.yaml with the popup guard allowing the camera', async () => {
    const { result } = await run('mydemo-camera-permission')
    expect(result.status).toBe('passed')
    expect(result.steps.flatMap((s) => s.popups_handled)).toEqual([
      { rule: 'android_permission', button: 'While using the app' },
    ])
  })

  it('shows typed text in the fields and draws the screens', async () => {
    const driver = new FakeDriver({
      ...sampleApp(),
      showTyped: true,
      renderScreens: { scale: 0.5 },
    })
    driver.show('login')
    const before = await driver.screenshot()
    const field = (await driver.tree())
      .flatMap((w) => [w, ...w.children])
      .find((n) => n.platform_id.endsWith('id/nameET'))
    await driver.tapAt({ x: (field?.bounds.x ?? 0) + 10, y: (field?.bounds.y ?? 0) + 10 })
    await driver.type('bod@example.com')
    const typed = (await driver.tree())
      .flatMap((w) => [w, ...w.children])
      .find((n) => n.platform_id.endsWith('id/nameET'))
    expect(typed?.text).toBe('bod@example.com')
    const after = await driver.screenshot()
    expect(after).not.toBe(before)
    expect(decode(after).width).toBe(540)
    await driver.resetApp(SAMPLE_APP)
    expect(driver.typed.size).toBe(0)
  })

  it('streams the drawn screen as live-view frames without recording a call', async () => {
    const driver = new FakeDriver({ ...sampleApp(), renderScreens: { scale: 0.5 } })
    driver.show('menu')
    const calls = driver.calls.length
    const frame = await driver.streamFrame({ maxEdge: 1280, quality: 60 })
    expect(frame).toMatchObject({
      mime: 'image/png',
      width: 540,
      height: 1200,
      deviceWidth: 1080,
      deviceHeight: 2400,
      rotation: 0,
    })
    expect(frame.image).toBe(await driver.screenshot())
    expect(driver.calls.length).toBe(calls + 1)
  })
})

describe('sample app screens for the Explorer (T020)', () => {
  const tapId = async (driver: FakeDriver, suffix: string) => {
    const node = [...walkTree(await driver.tree())].find(
      (n) => n.visible && n.platform_id.endsWith(`:id/${suffix}`),
    )
    if (!node) throw new Error(`${suffix} not on ${driver.current}`)
    await driver.tapAt({ x: node.bounds.x + 10, y: node.bounds.y + 10 })
  }
  const tapText = async (driver: FakeDriver, text: string) => {
    const node = [...walkTree(await driver.tree())].find((n) => n.visible && n.text === text)
    if (!node) throw new Error(`"${text}" not on ${driver.current}`)
    await driver.tapAt({ x: node.bounds.x + 10, y: node.bounds.y + 10 })
  }
  const open = async (item: string) => {
    const driver = new FakeDriver({ ...sampleApp(), showTyped: true })
    await driver.launch(SAMPLE_APP)
    await tapId(driver, 'menuIV')
    await tapText(driver, item)
    return driver
  }

  it('opens Search, Sign Up and Verify Code from the menu', async () => {
    expect((await open('Search')).current).toBe('search')
    const signup = await open('Sign Up')
    expect(signup.current).toBe('signup')
    await tapId(signup, 'signUpBtn')
    expect(signup.current).toBe('signup_done')
    expect((await open('About')).current).toBe('about')
  })

  it('accepts only the code of the fake OTP server', async () => {
    const driver = await open('Verify Code')
    await tapId(driver, 'otpET')
    await driver.type('000000')
    await tapId(driver, 'verifyBtn')
    expect(driver.current).toBe('otp_wrong')
    await tapId(driver, 'otpET')
    await driver.type(SAMPLE_OTP)
    await tapId(driver, 'verifyBtn')
    expect(driver.current).toBe('otp_done')
  })

  it('signs in with the demo password only; signed in, the menu offers Log Out', async () => {
    const driver = await open('Log In')
    await tapId(driver, 'loginBtn')
    expect(driver.current).toBe('login_wrong')
    expect([...walkTree(await driver.tree())].map((n) => n.text)).toContain(LOGIN_ERROR)
    await tapId(driver, 'passwordET')
    await driver.type(SAMPLE_PASSWORD)
    await tapId(driver, 'loginBtn')
    expect(driver.current).toBe('catalog_in')
    await tapId(driver, 'menuIV')
    const menu = [...walkTree(await driver.tree())].map((n) => n.text)
    expect(menu).toContain('Log Out')
    expect(menu).not.toContain('Log In')
    await tapText(driver, 'Log Out')
    expect(driver.current).toBe('catalog')
    expect((await open('Search')).current).toBe('search')
  })

  it('has a Place Order button behind the cart and a screen that tries to steer the AI', async () => {
    const driver = new FakeDriver({ ...sampleApp() })
    await driver.launch(SAMPLE_APP)
    await tapId(driver, 'cartIV')
    expect(driver.current).toBe('cart')
    const texts = [...walkTree(await driver.tree())].map((n) => n.text)
    expect(texts).toContain(PLACE_ORDER)
    driver.show('about')
    expect([...walkTree(await driver.tree())].map((n) => n.text)).toContain(INJECTION_TEXT)
  })

  it('draws every screen at the size of its tree', () => {
    for (const [name, screen] of Object.entries(sampleApp().screens)) {
      const png = decode(renderTree(screen.frames.at(-1) ?? [], { width: 1080, height: 2400 }))
      expect([png.width, png.height], name).toEqual([1080, 2400])
    }
  })
})
