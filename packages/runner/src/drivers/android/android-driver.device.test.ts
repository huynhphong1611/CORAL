import {
  DEFAULT_POPUPS_YAML,
  parseYaml,
  popupsSchema,
  walkTree,
  type ElementNode,
  type Locator,
} from '@coral/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { realClock } from '../../core/clock'
import { checkHit, touchTargetAt } from '../../core/hit-test'
import { center, contains } from '../../core/locator/geometry'
import { resolve } from '../../core/locator/resolve'
import { createPopupGuard, findPopups } from '../../core/popup-guard'
import { waitForStable } from '../../core/stability'
import { deviceTestEnv } from '../../testing/device-env'
import { createAndroidDriver, type AndroidDriver } from './android-driver'
import { defaultSpawner, U2_LAUNCH } from './u2-server'

// 🔌 Needs an Android device/emulator with the Sauce Labs My Demo App (quickstart §0, T039).
let driver: AndroidDriver
let env: Awaited<ReturnType<typeof deviceTestEnv>>

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function stableTree(): Promise<ElementNode[]> {
  return (await waitForStable(driver, realClock)).tree
}

/**
 * Waits for the app's window, letting other apps' system dialogs go on the way (a freshly booted
 * emulator often shows "Pixel Launcher isn't responding").
 */
async function waitForApp(timeoutMs = 30_000): Promise<ElementNode[]> {
  const guard = createPopupGuard({
    popups: popupsSchema.parse(parseYaml(DEFAULT_POPUPS_YAML).value),
    driver,
  })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const tree = await stableTree()
    if ([...walkTree(tree)].some((n) => n.package_or_bundle === env.appId)) return tree
    if (Date.now() > deadline) throw new Error(`${env.appId} not on screen after ${timeoutMs} ms`)
    const screen = await driver.windowSize()
    await guard.handle(tree, {
      appId: env.appId,
      reason: 'launch',
      resolveCtx: { platform: 'android', screen, appId: env.appId },
      limitReached: false,
    })
    await sleep(500)
  }
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

/** Window order of the u2 dump next to the system's z-order (research R5), for the CI log. */
async function logWindowOrder(label: string, tree: readonly ElementNode[]): Promise<void> {
  const dump = tree.map((w, i) => `  ${i} ${w.package_or_bundle} ${JSON.stringify(w.bounds)}`)
  const zOrder = (await env.adb.device(env.udid).shell(['dumpsys', 'window', 'windows']))
    .split('\n')
    .filter((line) => /^\s*Window #\d+/.test(line))
    .map((line) => `  ${line.trim()}`)
  console.log(
    `[${label}] u2 dump order:\n${dump.join('\n')}\n[${label}] dumpsys z-order:\n${zOrder.join('\n')}`,
  )
}

beforeAll(async () => {
  env = await deviceTestEnv()
  driver = await createAndroidDriver({ udid: env.udid, appId: env.appId, adbPath: env.adb.path })
  if (env.apk) await driver.install(env.apk, `device-test-${Date.now()}`)
  await driver.open()
  await driver.resetApp(env.appId)
  await driver.launch(env.appId)
  await waitForApp()
}, 120_000)

afterAll(async () => {
  await driver?.close()
})

describe('AndroidDriver on a real device', () => {
  it('starts u2 and dumps a tree with the app window', async () => {
    const tree = await stableTree()
    const packages = new Set([...walkTree(tree)].map((n) => n.package_or_bundle))
    expect(packages.has(env.appId)).toBe(true)
    await logWindowOrder('app screen', tree)
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

  it('keeps working after a second UiAutomation server started', async () => {
    const second = defaultSpawner(env.adb.path, [
      '-s',
      env.udid,
      'shell',
      U2_LAUNCH.replace('-p 9008', '-p 9019'),
    ])
    const deadline = Date.now() + 15_000
    while (
      Date.now() < deadline &&
      !/already registered|listening/.test(second.output()) &&
      !second.exited()
    ) {
      await sleep(250)
    }
    second.kill()
    // Older Android refuses the second client at start ("already registered", reported as
    // DRIVER_ERROR); Android 14 lets it start. Either way our server must still answer — the
    // client restarts it once on "UiAutomation not connected" (contracts/android-u2.md).
    expect(second.output()).toMatch(/already registered|listening/)
    const tree = await waitForApp()
    expect([...walkTree(tree)].some((n) => n.package_or_bundle === env.appId)).toBe(true)
  }, 60_000)

  it('sees the camera permission dialog as covering the app (window order, R5)', async () => {
    await driver.resetApp(env.appId)
    await driver.launch(env.appId)
    await waitForApp()
    await tap([{ desc: 'View menu' }, { android_id: 'id/menuIV' }])
    await tap([{ text: 'QR Code Scanner' }])
    let tree: ElementNode[]
    const deadline = Date.now() + 15_000
    do {
      tree = await stableTree()
    } while (findPopups(tree, env.appId).length === 0 && Date.now() < deadline)
    await logWindowOrder('permission dialog', tree)
    const popup = findPopups(tree, env.appId)[0]
    expect(popup?.root.package_or_bundle).toMatch(/permissioncontroller/)
    // Any point of the dialog is also on top of the app window: a tap there must not count as
    // reaching the app element below.
    const allow = popup?.nodes.find((n) => n.clickable)
    if (!allow) throw new Error('no button in the permission dialog')
    const point = center(allow.bounds)
    const appNode = [...walkTree(tree)]
      .filter((n) => n.package_or_bundle === env.appId && n.visible && contains(n.bounds, point))
      .at(-1)
    if (!appNode) throw new Error('no app node under the dialog')
    expect(checkHit(tree, appNode, point)).toMatchObject({ ok: false })
    expect(touchTargetAt(tree, point)?.package_or_bundle).toMatch(/permissioncontroller/)
    await driver.resetApp(env.appId)
  }, 90_000)
})
