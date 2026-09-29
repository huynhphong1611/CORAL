import {
  DEFAULT_POPUPS_YAML,
  parseYaml,
  popupsSchema,
  testCaseSchema,
  type ElementNode,
  type Popups,
} from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../testing/fake-clock'
import { FakeDriver, el, windows } from '../testing/fake-driver'
import { createPopupGuard } from './popup-guard'
import { runTestCase } from './run-testcase'

const APP = 'com.example.app'
const PERMISSION = 'com.google.android.permissioncontroller'
const popups: Popups = popupsSchema.parse(parseYaml(DEFAULT_POPUPS_YAML).value)

const appWindow = (...children: ReturnType<typeof el>[]) =>
  el({ bounds: [0, 0, 1080, 2400], children })
const home = appWindow(el({ text: 'Scan QR', clickable: true, bounds: [100, 300, 880, 120] }))
const permissionWindow = el({
  package_or_bundle: PERMISSION,
  bounds: [0, 0, 1080, 2400],
  children: [
    el({
      package_or_bundle: PERMISSION,
      text: 'Allow My Demo App to take pictures?',
      bounds: [120, 960, 840, 160],
    }),
    el({
      package_or_bundle: PERMISSION,
      text: 'While using the app',
      class: 'android.widget.Button',
      clickable: true,
      bounds: [120, 1200, 840, 120],
    }),
    el({
      package_or_bundle: PERMISSION,
      text: 'Don’t allow',
      class: 'android.widget.Button',
      clickable: true,
      bounds: [120, 1480, 840, 120],
    }),
  ],
})
const rateDialog = (n: number) =>
  el({
    bounds: [0, 0, 1080, 2400],
    children: [
      el({
        platform_id: 'android:id/parentPanel',
        bounds: [80, 900, 920, 600],
        children: [
          el({
            platform_id: 'android:id/alertTitle',
            text: `Đánh giá ứng dụng? (${n})`,
            bounds: [140, 950, 800, 100],
          }),
          el({
            platform_id: 'android:id/button2',
            text: 'Để sau',
            class: 'android.widget.Button',
            clickable: true,
            bounds: [400, 1370, 280, 110],
          }),
        ],
      }),
    ],
  })
const crashDialog = el({
  package_or_bundle: 'android',
  bounds: [0, 0, 1080, 2400],
  children: [
    el({
      package_or_bundle: 'android',
      platform_id: 'android:id/alertTitle',
      text: 'My Demo App keeps stopping',
      bounds: [140, 950, 800, 100],
    }),
    el({
      package_or_bundle: 'android',
      platform_id: 'android:id/aerr_close',
      text: 'Close app',
      class: 'android.widget.Button',
      clickable: true,
      bounds: [120, 1150, 840, 110],
    }),
  ],
})
const camera = windows(APP, appWindow(el({ text: 'Camera ready', bounds: [100, 300, 880, 120] })))

function run(
  screens: Record<string, { frames: ElementNode[][]; taps?: Record<string, string> }>,
  steps: object[],
  start = 'home',
) {
  const driver = new FakeDriver({ screens, start })
  const promise = runTestCase({
    driver,
    testCase: testCaseSchema.parse({
      schema: 'coral/testcase@1',
      id: 'scan',
      intent: 'x',
      platforms: ['android'],
      steps,
    }),
    appId: APP,
    clock: new FakeClock(),
    popupGuard: createPopupGuard({ popups, driver }),
  })
  return { driver, promise }
}

const scan = [
  { id: 's1', action: 'launch' },
  {
    id: 's2',
    action: 'tap',
    target: [{ text: 'Scan QR' }],
    expect: { visible_text: 'Camera ready' },
  },
]

describe('runTestCase with the popup guard', () => {
  it('allows the permission dialog that shows up between two steps', async () => {
    const { driver, promise } = run(
      {
        home: { frames: [windows(APP, home)], taps: { 'Scan QR': 'permission' } },
        permission: {
          frames: [windows(APP, home, permissionWindow)],
          taps: { 'While using the app': 'camera' },
        },
        camera: { frames: [camera] },
      },
      scan,
    )
    const result = await promise
    expect(result.status).toBe('passed')
    expect(result.steps[1]?.popups_handled).toEqual([
      { rule: 'android_permission', button: 'While using the app' },
    ])
    expect(
      driver.calls.filter((c) => c.kind === 'tap').map((c) => c.kind === 'tap' && c.node?.text),
    ).toEqual(['Scan QR', 'While using the app'])
  })

  it('handles a popup right after launch (D25)', async () => {
    const { promise } = run(
      {
        home: {
          frames: [windows(APP, home, permissionWindow)],
          taps: { 'While using the app': 'ready' },
        },
        ready: { frames: [windows(APP, home)], taps: { 'Scan QR': 'camera' } },
        camera: { frames: [camera] },
      },
      scan,
    )
    const result = await promise
    expect(result.status).toBe('passed')
    expect(result.steps[0]?.popups_handled).toEqual([
      { rule: 'android_permission', button: 'While using the app' },
    ])
  })

  it('handles at most 3 popups per step, then BLOCKED_BY_POPUP', async () => {
    const screens: Record<string, { frames: ElementNode[][]; taps?: Record<string, string> }> = {
      home: { frames: [windows(APP, home)], taps: { 'Scan QR': 'p1' } },
      camera: { frames: [camera] },
    }
    for (let n = 1; n <= 4; n++) {
      screens[`p${n}`] = {
        frames: [windows(APP, home, rateDialog(n))],
        taps: { 'Để sau': n === 4 ? 'camera' : `p${n + 1}` },
      }
    }
    const { driver, promise } = run(screens, scan)
    const result = await promise
    expect(result).toMatchObject({ status: 'failed', failure_code: 'BLOCKED_BY_POPUP' })
    expect(result.steps[1]?.popups_handled).toHaveLength(3)
    expect(driver.current).toBe('p4')
  })

  it('ends with APP_CRASHED on a crash dialog and leaves it on screen', async () => {
    const { driver, promise } = run(
      {
        home: { frames: [windows(APP, home)], taps: { 'Scan QR': 'crash' } },
        crash: { frames: [windows(APP, home, crashDialog)] },
      },
      scan,
    )
    const result = await promise
    expect(result).toMatchObject({
      status: 'failed',
      failure_code: 'APP_CRASHED',
      message: 'My Demo App keeps stopping',
    })
    expect(driver.calls.filter((c) => c.kind === 'tap')).toHaveLength(1)
  })

  it('lets a step test the permission dialog itself', async () => {
    const { driver, promise } = run(
      {
        home: { frames: [windows(APP, home)], taps: { 'Scan QR': 'permission' } },
        permission: {
          frames: [windows(APP, home, permissionWindow)],
          taps: { 'Don’t allow': 'denied' },
        },
        denied: {
          frames: [
            windows(
              APP,
              appWindow(el({ text: 'Camera permission denied', bounds: [0, 300, 1080, 100] })),
            ),
          ],
        },
      },
      [
        {
          id: 's1',
          action: 'tap',
          target: [{ text: 'Scan QR' }],
          expect: { visible_text: 'take pictures' },
        },
        {
          id: 's2',
          action: 'tap',
          target: [{ text: 'Don’t allow' }],
          expect: { visible_text: 'denied' },
        },
      ],
    )
    const result = await promise
    expect(result.status).toBe('passed')
    expect(result.steps.flatMap((s) => s.popups_handled)).toEqual([])
    expect(
      driver.calls.filter((c) => c.kind === 'tap').map((c) => c.kind === 'tap' && c.node?.text),
    ).toEqual(['Scan QR', 'Don’t allow'])
  })
})
