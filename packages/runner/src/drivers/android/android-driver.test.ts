import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Adb, type ExecFn } from './adb'
import { AndroidDriver, FOCUSED_SELECTOR, type U2Rpc } from './android-driver'
import { AndroidLifecycle } from './lifecycle'

const APP = 'com.saucelabs.mydemoapp.android'
const LOGIN_XML = readFileSync(
  new URL('../../../../../fixtures/android/login.xml', import.meta.url),
  'utf8',
)
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function setup(opts: { imeShown?: boolean; screencap?: Buffer; windows?: string } = {}) {
  const rpc: { method: string; params: unknown[] }[] = []
  const u2: U2Rpc & { started: number; stopped: number } = {
    started: 0,
    stopped: 0,
    start() {
      this.started += 1
      return Promise.resolve()
    },
    stop() {
      this.stopped += 1
      return Promise.resolve()
    },
    call<T>(method: string, params: unknown[] = []) {
      rpc.push({ method, params })
      const result =
        method === 'dumpWindowHierarchy'
          ? LOGIN_XML
          : method === 'deviceInfo'
            ? { displayWidth: 1080, displayHeight: 2400 }
            : true
      return Promise.resolve(result as T)
    },
  }
  const adbCalls: string[] = []
  const exec: ExecFn = (_f, args) => {
    const key = args.slice(2).join(' ')
    adbCalls.push(key)
    if (key === 'exec-out screencap -p') return Promise.resolve(opts.screencap ?? PNG)
    if (key === 'shell dumpsys window windows') {
      return opts.windows === undefined
        ? Promise.reject(new Error('dumpsys failed'))
        : Promise.resolve(Buffer.from(opts.windows))
    }
    if (key === 'shell dumpsys input_method')
      return Promise.resolve(Buffer.from(`  mInputShown=${opts.imeShown ? 'true' : 'false'}\n`))
    return Promise.resolve(Buffer.from(''))
  }
  const device = new Adb('adb', exec).device('emu-1')
  const driver = new AndroidDriver(
    device,
    u2,
    new AndroidLifecycle(device, { appId: APP, apiLevel: 34, emulator: true }),
  )
  return { driver, rpc, adbCalls, u2 }
}

describe('AndroidDriver', () => {
  it('reads the tree and the window size through u2', async () => {
    const { driver, rpc } = setup()
    const tree = await driver.tree()
    expect(tree[0]?.package_or_bundle).toBe(APP)
    expect(await driver.windowSize()).toEqual({ width: 1080, height: 2400 })
    expect(rpc.map((r) => [r.method, r.params])).toEqual([
      ['dumpWindowHierarchy', [false, 50]],
      ['deviceInfo', []],
    ])
  })

  it('orders windows by the window manager z-order read alongside the dump', async () => {
    // Deliberately odd z-order (app above the status bar) to show that it is what decides.
    const windows = [
      `  Window #0 Window{1 u0 ${APP}/${APP}.Main}:`,
      `    mOwnerUid=10190 showForAllUsers=false package=${APP} appop=NONE`,
      '    Frames: parent=[0,0][1080,2400] display=[0,0][1080,2400] frame=[0,0][1080,2400]',
      '  Window #1 Window{2 u0 StatusBar}:',
      '    mOwnerUid=10120 showForAllUsers=true package=com.android.systemui appop=NONE',
      '    Frames: parent=[0,0][1080,80] display=[0,0][1080,80] frame=[0,0][1080,80]',
    ].join('\n')
    const { driver, adbCalls } = setup({ windows })
    expect((await driver.tree()).map((w) => w.package_or_bundle)).toEqual([
      'com.android.systemui',
      APP,
    ])
    expect(adbCalls).toContain('shell dumpsys window windows')
    // dumpsys failing (setup default) falls back to window classes: status bar on top.
    expect((await setup().driver.tree()).at(-1)?.package_or_bundle).toBe('com.android.systemui')
  })

  it('maps gestures and text input to u2 calls', async () => {
    const { driver, rpc } = setup()
    await driver.tapAt({ x: 10, y: 20 })
    await driver.longPressAt({ x: 10, y: 20 }, 1500)
    await driver.swipe({ x: 1, y: 2 }, { x: 3, y: 4 }, 300)
    await driver.back()
    await driver.type('Mật khẩu có dấu ✓')
    await driver.clearText()
    expect(rpc.map((r) => [r.method, r.params])).toEqual([
      ['click', [10, 20]],
      ['click', [10, 20, 1500]],
      ['swipe', [1, 2, 3, 4, 60]],
      ['pressKey', ['back']],
      ['setText', [FOCUSED_SELECTOR, 'Mật khẩu có dấu ✓']],
      ['clearTextField', [FOCUSED_SELECTOR]],
    ])
  })

  it('hides the keyboard only when it is shown', async () => {
    const hidden = setup({ imeShown: false })
    await hidden.driver.hideKeyboard()
    expect(hidden.rpc).toEqual([])
    const shown = setup({ imeShown: true })
    await shown.driver.hideKeyboard()
    expect(shown.rpc).toEqual([{ method: 'pressKey', params: ['back'] }])
  })

  it('takes PNG screenshots with screencap and rejects anything else', async () => {
    expect(Buffer.from(await setup().driver.screenshot())).toEqual(PNG)
    await expect(
      setup({ screencap: Buffer.from('error: closed') }).driver.screenshot(),
    ).rejects.toThrow('PNG')
  })

  it('open() starts u2 and disables animations; close() stops u2', async () => {
    const { driver, u2, adbCalls } = setup()
    await driver.open()
    await driver.close()
    expect([u2.started, u2.stopped]).toEqual([1, 1])
    expect(adbCalls.filter((c) => c.startsWith('shell settings put'))).toHaveLength(3)
  })

  it('delegates the lifecycle to adb', async () => {
    const { driver, adbCalls } = setup()
    await driver.launch(APP)
    expect(adbCalls).toContain(`shell monkey -p ${APP} -c android.intent.category.LAUNCHER 1`)
  })
})
