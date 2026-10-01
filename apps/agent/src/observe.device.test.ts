import { DEFAULT_POPUPS_YAML, createRedactor, screenFingerprint, walkTree } from '@coral/shared'
import { android, imageInfo } from '@coral/runner'
import { deviceTestEnv } from '@coral/runner/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { observe } from './recorder'

// 🔌 T018: `observe` on an Android emulator with My Demo App (CORAL_TEST_APK installs it first).
let env: Awaited<ReturnType<typeof deviceTestEnv>>
let driver: android.AndroidDriver
const puts = new Map<string, Uint8Array | string>()

beforeAll(async () => {
  env = await deviceTestEnv()
  driver = await android.createAndroidDriver({
    udid: env.udid,
    appId: env.appId,
    adbPath: env.adb.path,
  })
  if (env.apk) await driver.install(env.apk, `observe-test-${Date.now()}`)
  await driver.open()
  await driver.resetApp(env.appId)
  await driver.launch(env.appId)
}, 120_000)

afterAll(async () => {
  await driver?.close()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function look() {
  return observe(
    {
      driver,
      redactor: createRedactor([]),
      put: (url, body) => {
        puts.set(url, body)
        return Promise.resolve()
      },
    },
    {
      kind: 'observe',
      package: env.appId,
      popups_yaml: DEFAULT_POPUPS_YAML,
      upload: { screen: 'mem://screen.jpg', ai: 'mem://ai.jpg', tree: 'mem://tree.json' },
      redact: [],
    },
  )
}

describe('observe on a real device (T018)', () => {
  it('sees the catalog with its activity, both pictures, and the same fingerprint twice', async () => {
    // The splash screen comes first on a cold start.
    let first = await look()
    for (let i = 0; i < 20; i += 1) {
      if ([...walkTree(first.tree)].some((n) => n.visible && n.platform_id.endsWith(':id/menuIV')))
        break
      await sleep(1000)
      first = await look()
    }
    expect(first).toMatchObject({ package: env.appId, app_running: true, crash: null })
    expect(first.activity).toMatch(/Activity$/)
    expect(first.tree.some((w) => w.package_or_bundle === env.appId)).toBe(true)
    const ai = imageInfo(puts.get('mem://ai.jpg') as Uint8Array)
    expect(Math.max(ai?.width ?? 0, ai?.height ?? 0)).toBe(1024)
    expect(imageInfo(puts.get('mem://screen.jpg') as Uint8Array)).toMatchObject({
      width: first.screen_width,
      height: first.screen_height,
    })

    const second = await look()
    const context = (o: typeof first) => ({
      package: env.appId,
      ...(o.activity ? { activity: o.activity } : {}),
    })
    const print = screenFingerprint(first.tree, context(first))
    console.log(`[observe] ${first.activity} fingerprint ${print}`)
    expect(screenFingerprint(second.tree, context(second))).toBe(print)
  }, 90_000)
})
