import { testCaseSchema } from '@coral/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { FakeClock } from '../testing/fake-clock'
import { FakeDriver, el, windows } from '../testing/fake-driver'
import { renderTree } from '../testing/render'
import { loadOpenCv } from './image/opencv'
import type { ImageMatcher } from './image/matcher'
import { cropPng } from './image/png'
import { runTestCase } from './run-testcase'

// US6 T051: `image` locators at run time — tried in their place in the chain on a screenshot,
// a match is a virtual element whose centre is tapped; degraded when an earlier locator missed.
const APP = 'com.example.shop'
const SIZE = { width: 1080, height: 2400 }
const REFERENCE = 'snap/login/s2/element.png'
const BUTTON = { x: 60, y: 920, w: 960, h: 140 }

const button = (id: string, dy = 0) =>
  el({
    platform_id: `${APP}:id/${id}`,
    text: 'Login',
    class: 'android.widget.Button',
    clickable: true,
    bounds: [BUTTON.x, BUTTON.y + dy, BUTTON.w, BUTTON.h],
  })
const login = (...children: ReturnType<typeof el>[]) =>
  windows(
    APP,
    el({
      bounds: [0, 0, 1080, 2400],
      children: [
        el({ text: 'Sign in to the shop', bounds: [40, 260, 700, 90] }),
        el({ class: 'android.widget.EditText', clickable: true, bounds: [40, 500, 1000, 120] }),
        ...children,
      ],
    }),
  )
const products = windows(
  APP,
  el({
    bounds: [0, 0, 1080, 2400],
    children: [el({ text: 'Products', bounds: [40, 260, 600, 90] })],
  }),
)
/** A dialog of another app on top: it takes every tap (touch-modal), the button stays visible. */
const dialog = el({
  package_or_bundle: 'com.other.app',
  bounds: [80, 1500, 920, 400],
  children: [
    el({
      package_or_bundle: 'com.other.app',
      text: 'Update available',
      bounds: [120, 1540, 800, 100],
    }),
  ],
})

/** The button as the Recorder cut it: from the screen drawn with its original id. */
const reference = cropPng(renderTree(login(button('loginBtn')), SIZE), BUTTON)

function driver(start: string, renderScreens: boolean | { scale: number } = true) {
  return new FakeDriver({
    start,
    initial: start,
    renderScreens,
    screens: {
      renamed: {
        frames: [login(button('signInButton', 300))],
        taps: { [`${APP}:id/signInButton`]: 'products' },
      },
      gone: { frames: [login()] },
      covered: {
        frames: [[...login(button('signInButton', 300)), ...windows('com.other.app', dialog)]],
      },
      products: { frames: [products] },
    },
  })
}

const testCase = (target: unknown[]) =>
  testCaseSchema.parse({
    schema: 'coral/testcase@1',
    id: 'login-by-image',
    intent: 'Log in when the button changed its id',
    platforms: ['android'],
    steps: [{ id: 's1', action: 'tap', target, expect: { visible_text: 'Products' } }],
  })

const byId = { android_id: 'id/loginBtn' }
const byImage = { image: { path: REFERENCE, screen_width: 1080 } }

async function run(d: FakeDriver, target: unknown[], matcher?: ImageMatcher) {
  const reads: string[] = []
  const result = await runTestCase({
    driver: d,
    testCase: testCase(target),
    appId: APP,
    clock: new FakeClock(),
    stableTimeoutMs: 50,
    assets: (path) => {
      reads.push(path)
      return Promise.resolve(reference)
    },
    ...(matcher ? { imageMatcher: matcher } : {}),
  })
  const taps = d.calls
    .filter((c) => c.kind === 'tap')
    .map((c) => ('point' in c ? c.point : undefined))
  return { result, step: result.steps[0], taps, reads }
}

beforeAll(async () => {
  await loadOpenCv()
}, 60_000)

describe('image locators at run time (T051)', { timeout: 60_000 }, () => {
  it('finds the button by its picture when its id changed: tap at the centre, degraded', async () => {
    const { result, step, taps, reads } = await run(driver('renamed'), [byId, byImage])
    expect(result.status).toBe('passed')
    expect(step).toMatchObject({ locator_used_index: 1, degraded: true, status: 'passed' })
    expect(taps).toEqual([{ x: 540, y: 920 + 300 + 70 }])
    expect(reads).toEqual([REFERENCE])
  })

  it('is not degraded when the picture is the first locator', async () => {
    const { step } = await run(driver('renamed'), [byImage])
    expect(step).toMatchObject({ locator_used_index: 0, degraded: false, status: 'passed' })
  })

  it('fails with TARGET_NOT_FOUND when nothing looks like it (no blind tap)', async () => {
    const { result, step, taps } = await run(driver('gone'), [byId, byImage])
    expect(result.status).toBe('failed')
    expect(step).toMatchObject({ failure_code: 'TARGET_NOT_FOUND', locator_used_index: null })
    expect(taps).toEqual([])
  })

  it('does not tap when another window takes the tap (checked at window level)', async () => {
    const { step, taps } = await run(driver('covered'), [byId, byImage])
    expect(step).toMatchObject({ failure_code: 'TARGET_NOT_FOUND' })
    expect(step?.message).toContain('covered')
    expect(taps).toEqual([])
  })

  it('skips image locators without assets, like a locator that misses', async () => {
    const d = driver('renamed')
    const result = await runTestCase({
      driver: d,
      testCase: testCase([byId, byImage]),
      appId: APP,
      clock: new FakeClock(),
      stableTimeoutMs: 50,
    })
    expect(result.steps[0]).toMatchObject({ failure_code: 'TARGET_NOT_FOUND' })
  })

  it('scales the reference to the screenshot and maps the match back to device pixels', async () => {
    const asked: { scale?: number | undefined; threshold: number }[] = []
    const matcher: ImageMatcher = {
      find: (_screen, _template, options) => {
        asked.push(options)
        return Promise.resolve({ bounds: { x: 30, y: 610, w: 480, h: 70 }, score: 0.97 })
      },
    }
    const { step, taps } = await run(driver('renamed', { scale: 0.5 }), [byImage], matcher)
    expect(asked).toEqual([{ threshold: 0.85, scale: 0.5 }])
    expect(step).toMatchObject({ status: 'passed', locator_used_index: 0 })
    expect(taps).toEqual([{ x: (30 + 240) * 2, y: (610 + 35) * 2 }])
  })
})
