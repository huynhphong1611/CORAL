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
import { openCvMatcher } from '../../core/image/opencv'
import { imageInfo } from '../../core/image/size'
import { snapshotFromPng } from '../../core/recorder/crop'
import { checkHit, touchTargetAt } from '../../core/hit-test'
import { center, contains } from '../../core/locator/geometry'
import { resolve } from '../../core/locator/resolve'
import { createPopupGuard, findPopups } from '../../core/popup-guard'
import { waitForStable } from '../../core/stability'
import { deviceTestEnv } from '../../testing/device-env'
import { createAndroidDriver, type AndroidDriver } from './android-driver'
import { matchWindowLayers, parseWindowLayers } from './hierarchy'
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
  const started = Date.now()
  const guard = createPopupGuard({
    popups: popupsSchema.parse(parseYaml(DEFAULT_POPUPS_YAML).value),
    driver,
  })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const tree = await stableTree()
    if ([...walkTree(tree)].some((n) => n.package_or_bundle === env.appId)) return tree
    if (Date.now() > deadline) {
      throw new Error(
        `${env.appId} not on screen after ${timeoutMs} ms\n${await describeScreen(tree, started)}`,
      )
    }
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

/** Lines of `dumpsys` / `logcat` that tell why an app is not on screen. */
const LAUNCH_LOG =
  /ActivityTaskManager|ActivityManager|AndroidRuntime|Zygote|WindowManager|libprocessgroup|mydemoapp/

/**
 * What is on screen instead of the app: windows, some texts, the focused window and resumed
 * activity, the app's pid and the activity-manager log from 10 s before `sinceMs` (reset, launch).
 */
async function describeScreen(tree: readonly ElementNode[], sinceMs: number): Promise<string> {
  const shell = (args: string[]) => env.adb.device(env.udid).shell(args).catch(String)
  const grep = (text: string, pattern: RegExp) =>
    text
      .split('\n')
      .filter((line) => pattern.test(line))
      .map((line) => line.trim())
  const texts = [...walkTree(tree)]
    .map((n) => n.text || n.desc)
    .filter(Boolean)
    .slice(0, 15)
  const focus = grep(await shell(['dumpsys', 'window']), /mCurrentFocus|mFocusedApp/)
  const resumed = grep(await shell(['dumpsys', 'activity', 'activities']), /ResumedActivity/)
  const log = grep(await driver.deviceLogs(sinceMs - 10_000).catch(String), LAUNCH_LOG)
  return [
    `windows: ${tree.map((w) => `${w.package_or_bundle} ${JSON.stringify(w.bounds)}`).join(' | ')}`,
    `texts: ${JSON.stringify(texts)}`,
    ...focus,
    ...resumed.slice(0, 4),
    `pidof ${env.appId}: ${(await shell(['pidof', env.appId])).trim() || 'none'}`,
    `device log around the launch (${log.length} activity/app lines, last 80):`,
    ...log.slice(-80),
  ].join('\n')
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
/**
 * Logs the tree's windows next to the window manager's z-order and checks that every dumped
 * window matched a layer and that the tree is bottom-most first by it (research R5).
 */
async function checkWindowOrder(label: string, tree: readonly ElementNode[]): Promise<void> {
  const layers = parseWindowLayers(
    await env.adb.device(env.udid).shell(['dumpsys', 'window', 'windows']),
  )
  const z = matchWindowLayers(
    tree.map((w) => ({ package: w.package_or_bundle, bounds: w.bounds })),
    layers,
  )
  const dumped = tree.map(
    (w, i) => `  ${i} ${w.package_or_bundle} ${JSON.stringify(w.bounds)} → layer ${z?.[i] ?? '?'}`,
  )
  const wm = layers.map((l, i) => `  ${i} ${l.package} ${JSON.stringify(l.frame)}`)
  console.log(
    `[${label}] tree, bottom-most first:\n${dumped.join('\n')}\n[${label}] window manager, top-most first:\n${wm.join('\n')}`,
  )
  expect(z, `${label}: every dumped window has a window-manager layer`).toBeDefined()
  expect(z).toEqual([...(z ?? [])].sort((a, b) => b - a))
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
    await checkWindowOrder('app screen', tree)
    const size = await driver.windowSize()
    expect(size.width).toBeGreaterThan(0)
  })

  it('takes a PNG screenshot', async () => {
    const png = await driver.screenshot()
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(png.length).toBeGreaterThan(10_000)
  })

  it('finds the menu button by its picture after the menu opened and closed (US6, R12)', async () => {
    const size = await driver.windowSize()
    const menu = [...walkTree(await stableTree())].find((n) => n.platform_id.endsWith(':id/menuIV'))
    if (!menu) throw new Error('no menu button on the first screen')
    const first = await driver.screenshot()
    const width = imageInfo(first)?.width ?? size.width
    const reference = snapshotFromPng(first, size, menu.bounds).element
    if (!reference) throw new Error('could not cut the menu button')

    await tap([{ android_id: 'id/menuIV' }, { desc: 'View menu' }])
    await stableTree()
    await driver.back()
    await stableTree()
    const again = await driver.screenshot()
    const matcher = openCvMatcher()
    await matcher.find(again, reference, { threshold: 0.85 }) // loads OpenCV
    const started = Date.now()
    const match = await matcher.find(again, reference, {
      threshold: 0.85,
      scale: (imageInfo(again)?.width ?? width) / width,
    })
    const ms = Date.now() - started
    console.log(
      `[image] menu ${JSON.stringify(menu.bounds)} → ${JSON.stringify(match)} in ${ms} ms`,
    )
    expect(match?.score).toBeGreaterThanOrEqual(0.85)
    const k = size.width / width
    expect(Math.abs((match?.bounds.x ?? -99) * k - menu.bounds.x)).toBeLessThanOrEqual(4)
    expect(Math.abs((match?.bounds.y ?? -99) * k - menu.bounds.y)).toBeLessThanOrEqual(4)
    expect(ms).toBeLessThan(1000)
  }, 60_000)

  it('streams a live-view frame: JPEG ≤ 300 KB within 1 s (research R4)', async () => {
    await driver.streamFrame({ maxEdge: 1280, quality: 60 })
    const started = Date.now()
    const frame = await driver.streamFrame({ maxEdge: 1280, quality: 60 })
    const elapsedMs = Date.now() - started
    console.log(
      `stream frame: ${frame.mime} ${frame.width}x${frame.height} of ` +
        `${frame.deviceWidth}x${frame.deviceHeight}, ${frame.image.length} bytes in ${elapsedMs} ms`,
    )
    expect(frame.mime).toBe('image/jpeg')
    expect(frame.image.length).toBeLessThanOrEqual(300 * 1024)
    expect(elapsedMs).toBeLessThanOrEqual(1000)
    // u2 ignores the scale (research R4): max_edge is a hint, the frame may be full size.
    expect(Math.max(frame.width, frame.height)).toBeLessThanOrEqual(
      Math.max(frame.deviceWidth, frame.deviceHeight),
    )
    // Same aspect ratio as the screen, so clicks map back within 1 % (US3).
    expect(frame.width / frame.height).toBeCloseTo(frame.deviceWidth / frame.deviceHeight, 2)
    expect(frame.rotation).toBe(0)
  })

  it('taps through to the login form and types Vietnamese exactly', async () => {
    await tap([{ desc: 'View menu' }, { android_id: 'id/menuIV' }])
    await tap([{ text: 'Log In' }, { text_contains: 'Log In' }])
    await tap([{ android_id: 'id/nameET' }])
    const text = 'Nguyễn Văn Ánh ệ ữ ỷ'
    await driver.clearText()
    await driver.type(text)
    const tree = await stableTree()
    const field = [...walkTree(tree)].find((n) => n.platform_id.endsWith(':id/nameET'))
    expect(field?.text).toBe(text)
    // With the keyboard open, its window (when the dump has it) must sit above the app's.
    await checkWindowOrder('keyboard', tree)
    const ime = tree.findIndex((w) => /inputmethod|keyboard/i.test(w.package_or_bundle))
    const app = tree.findIndex((w) => w.package_or_bundle === env.appId)
    if (ime >= 0 && app >= 0) expect(ime).toBeGreaterThan(app)
  }, 60_000)

  it('sees the camera permission dialog on top (window order, R5)', async () => {
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
    await checkWindowOrder('permission dialog', tree)
    const popup = findPopups(tree, env.appId)[0]
    expect(popup?.root.package_or_bundle).toMatch(/permissioncontroller/)
    const allow = popup?.nodes.find((n) => n.clickable)
    if (!allow) throw new Error('no button in the permission dialog')
    const point = center(allow.bounds)
    expect(touchTargetAt(tree, point)?.package_or_bundle).toMatch(/permissioncontroller/)
    // The status bar is above the dialog (window manager z-order); the app, if dumped at all, is
    // below it.
    expect(tree.at(-1)?.package_or_bundle).toBe('com.android.systemui')
    const dialog = tree.indexOf(popup?.root as ElementNode)
    const app = tree.findIndex((w) => w.package_or_bundle === env.appId)
    if (app >= 0) {
      expect(app).toBeLessThan(dialog)
      const under = [...walkTree([tree[app] as ElementNode])]
        .filter((n) => n.visible && contains(n.bounds, point))
        .at(-1)
      if (under) expect(checkHit(tree, under, point)).toMatchObject({ ok: false })
    }
    await driver.resetApp(env.appId)
  }, 90_000)

  // Last: a second UiAutomation server disturbs ours (the client restarts it).
  it('keeps working after a second UiAutomation server started', async () => {
    await driver.launch(env.appId)
    await waitForApp()
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
})
