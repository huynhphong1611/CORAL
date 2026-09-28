import { walkTree, type ElementNode, type Locator } from '@coral/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { realClock } from '../../core/clock'
import { resolve } from '../../core/locator/resolve'
import { waitForStable } from '../../core/stability'
import { deviceTestEnv } from '../../testing/device-env'
import { createAndroidDriver, type AndroidDriver } from './android-driver'
import { defaultSpawner, U2_LAUNCH } from './u2-server'

// 🔌 Needs an Android device/emulator with the Sauce Labs My Demo App (quickstart §0, T039).
let driver: AndroidDriver
let env: Awaited<ReturnType<typeof deviceTestEnv>>

async function stableTree(): Promise<ElementNode[]> {
  return (await waitForStable(driver, realClock)).tree
}

async function tap(target: Locator[]): Promise<void> {
  const size = await driver.windowSize()
  const found = resolve(target, await stableTree(), {
    platform: 'android',
    screen: size,
    appId: env.appId,
  })
  if (!found) throw new Error(`not found: ${JSON.stringify(target)}`)
  await driver.tapAt(found.point)
}

beforeAll(async () => {
  env = await deviceTestEnv()
  driver = await createAndroidDriver({ udid: env.udid, appId: env.appId, adbPath: env.adb.path })
  if (env.apk) await driver.install(env.apk, `device-test-${Date.now()}`)
  await driver.open()
  await driver.resetApp(env.appId)
  await driver.launch(env.appId)
}, 120_000)

afterAll(async () => {
  await driver?.close()
})

describe('AndroidDriver on a real device', () => {
  it('starts u2 and dumps a tree with the app window', async () => {
    const tree = await stableTree()
    const packages = new Set([...walkTree(tree)].map((n) => n.package_or_bundle))
    expect(packages.has(env.appId)).toBe(true)
    // Window order assumption of research R5 / fixtures README: system UI windows come last.
    expect(tree.at(-1)?.package_or_bundle).not.toBe(env.appId)
    const size = await driver.windowSize()
    expect(size.width).toBeGreaterThan(0)
  })

  it('takes a PNG screenshot', async () => {
    const png = await driver.screenshot()
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(png.length).toBeGreaterThan(10_000)
  })

  it('taps through to the login form and types Vietnamese exactly', async () => {
    await tap([{ desc: 'View menu' }, { android_id: 'id/menuIV' }])
    await tap([{ text: 'Log In' }, { text_contains: 'Log In' }])
    await tap([{ android_id: 'id/nameET' }])
    const text = 'Nguyễn Văn Ánh ệ ữ ỷ'
    await driver.clearText()
    await driver.type(text)
    const field = [...walkTree(await stableTree())].find((n) =>
      n.platform_id.endsWith(':id/nameET'),
    )
    expect(field?.text).toBe(text)
  }, 60_000)

  it('reports "already registered" when a second UiAutomation server starts', async () => {
    const second = defaultSpawner(env.adb.path, [
      '-s',
      env.udid,
      'shell',
      U2_LAUNCH.replace('-p 9008', '-p 9019'),
    ])
    const deadline = Date.now() + 15_000
    while (
      Date.now() < deadline &&
      !second.output().includes('already registered') &&
      !second.exited()
    ) {
      await new Promise((r) => setTimeout(r, 250))
    }
    second.kill()
    expect(second.output()).toContain('already registered')
  }, 20_000)
})
