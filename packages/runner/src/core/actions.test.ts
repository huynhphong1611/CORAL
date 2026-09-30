import { stepSchema, type ElementNode } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../testing/fake-clock'
import { FakeDriver, el, windows } from '../testing/fake-driver'
import { perform, type ActionContext } from './actions'
import { StepFailure, TargetCoveredError } from './errors'
import { resolve } from './locator/resolve'

const APP = 'com.example'
const form = windows(
  APP,
  el({
    bounds: [0, 0, 1000, 2000],
    children: [
      el({
        platform_id: `${APP}:id/name`,
        class: 'android.widget.EditText',
        clickable: true,
        bounds: [100, 100, 800, 100],
      }),
      el({
        text: 'Go',
        class: 'android.widget.Button',
        clickable: true,
        bounds: [100, 300, 800, 100],
      }),
      el({ platform_id: `${APP}:id/list`, bounds: [0, 1000, 1000, 800] }),
    ],
  }),
)
const covered = windows(
  APP,
  el({
    bounds: [0, 0, 1000, 2000],
    children: [el({ text: 'Go', clickable: true, bounds: [100, 300, 800, 100] })],
  }),
  el({ package_or_bundle: 'com.android.permissioncontroller', bounds: [0, 200, 1000, 400] }),
)
const listWith = (item: string) =>
  windows(
    APP,
    el({ bounds: [0, 0, 1000, 2000], children: [el({ text: item, bounds: [0, 500, 1000, 100] })] }),
  )

function setup(
  tree: ElementNode[] = form,
  screens: Record<string, { frames: ElementNode[][] }> = {},
) {
  const driver = new FakeDriver({
    screens: { main: { frames: [tree] }, ...screens },
    start: 'main',
    size: { width: 1000, height: 2000 },
  })
  const clock = new FakeClock()
  const ctx: ActionContext = {
    driver,
    clock,
    appId: APP,
    resolveCtx: { platform: 'android', screen: { width: 1000, height: 2000 }, appId: APP },
  }
  const run = async (raw: object) => {
    const step = stepSchema.parse({ id: 's1', ...raw })
    const target =
      'target' in step && step.target && step.action !== 'scroll_to'
        ? resolve(step.target, tree, ctx.resolveCtx)
        : undefined
    return perform({ step, tree, ...(target ? { target } : {}) }, ctx)
  }
  return { driver, clock, run }
}

describe('actions', () => {
  it('launch and open_deeplink go through the lifecycle', async () => {
    const { driver, run } = setup()
    await run({ action: 'launch' })
    await run({ action: 'open_deeplink', url: 'myapp://x/1' })
    expect(driver.calls).toEqual([
      { kind: 'launch', appId: APP },
      { kind: 'openDeepLink', url: 'myapp://x/1' },
    ])
  })

  it('tap hits the centre of the target bounds', async () => {
    const { driver, run } = setup()
    await run({ action: 'tap', target: [{ text: 'Go' }] })
    expect(driver.calls[0]).toMatchObject({ kind: 'tap', point: { x: 500, y: 350 } })
  })

  it('refuses to tap a covered target', async () => {
    const { driver, run } = setup(covered)
    await expect(run({ action: 'tap', target: [{ text: 'Go' }] })).rejects.toBeInstanceOf(
      TargetCoveredError,
    )
    expect(driver.calls).toEqual([])
  })

  it('long_press defaults to 1000 ms', async () => {
    const { driver, run } = setup()
    await run({ action: 'long_press', target: [{ text: 'Go' }] })
    await run({ action: 'long_press', ms: 2500, target: [{ text: 'Go' }] })
    expect(driver.calls.map((c) => ('ms' in c ? c.ms : undefined))).toEqual([1000, 2500])
  })

  it('type focuses the target, clears when asked, then types Unicode', async () => {
    const { driver, run } = setup()
    await run({
      action: 'type',
      target: [{ android_id: 'id/name' }],
      value: 'Tiếng Việt',
      clear_first: true,
    })
    expect(driver.calls.map((c) => c.kind)).toEqual(['tap', 'clearText', 'type'])
    expect([...driver.typed.values()]).toEqual(['Tiếng Việt'])
    await run({ action: 'type', value: '!' })
    expect(driver.calls.at(-1)).toEqual({ kind: 'type', text: '!' })
  })

  it('clear taps then clears', async () => {
    const { driver, run } = setup()
    await run({ action: 'clear', target: [{ android_id: 'id/name' }] })
    expect(driver.calls.map((c) => c.kind)).toEqual(['tap', 'clearText'])
  })

  it('swipes by direction on the screen or inside the target, or between points', async () => {
    const { driver, run } = setup()
    await run({ action: 'swipe', direction: 'up' })
    await run({
      action: 'swipe',
      direction: 'left',
      distance_pct: 0.5,
      target: [{ android_id: 'id/list' }],
    })
    await run({ action: 'swipe', from: [0.5, 0.8], to: [0.5, 0.2], ms: 400 })
    expect(driver.calls).toEqual([
      { kind: 'swipe', from: { x: 500, y: 1600 }, to: { x: 500, y: 400 }, ms: 300 },
      { kind: 'swipe', from: { x: 750, y: 1400 }, to: { x: 250, y: 1400 }, ms: 300 },
      { kind: 'swipe', from: { x: 500, y: 1600 }, to: { x: 500, y: 400 }, ms: 400 },
    ])
  })

  it('scroll_to swipes until the element shows up', async () => {
    class Scrolling extends FakeDriver {
      override async swipe(...args: Parameters<FakeDriver['swipe']>) {
        await super.swipe(...args)
        this.show(this.current === 'main' ? 'page2' : 'page3')
      }
    }
    const clock = new FakeClock()
    const driver = new Scrolling({
      screens: {
        main: { frames: [listWith('Item 1')] },
        page2: { frames: [listWith('Item 5')] },
        page3: { frames: [listWith('Item 9')] },
      },
      start: 'main',
      size: { width: 1000, height: 2000 },
    })
    const ctx: ActionContext = {
      driver,
      clock,
      appId: APP,
      resolveCtx: { platform: 'android', screen: { width: 1000, height: 2000 } },
    }
    const step = stepSchema.parse({ id: 's', action: 'scroll_to', target: [{ text: 'Item 9' }] })
    const outcome = await perform({ step, tree: listWith('Item 1') }, ctx)
    expect(outcome.target?.node?.text).toBe('Item 9')
    // direction down (default) = finger moves up.
    expect(driver.calls.filter((c) => c.kind === 'swipe')).toHaveLength(2)
    expect(driver.calls[0]).toMatchObject({ from: { y: 1500 }, to: { y: 500 } })

    const never = stepSchema.parse({
      id: 's',
      action: 'scroll_to',
      max_swipes: 1,
      target: [{ text: 'Nope' }],
    })
    await expect(perform({ step: never, tree: listWith('Item 1') }, ctx)).rejects.toMatchObject({
      code: 'TARGET_NOT_FOUND',
      message: 'not found after 1 swipes',
    })
  })

  it('back, hide_keyboard and assert', async () => {
    const { driver, run } = setup()
    await run({ action: 'back' })
    await run({ action: 'hide_keyboard' })
    await run({ action: 'assert', expect: { visible_text: 'Go' } })
    expect(driver.calls.map((c) => c.kind)).toEqual(['back', 'hideKeyboard'])
  })

  it('wait sleeps or waits until a condition, failing with EXPECT_FAILED', async () => {
    const { clock, run } = setup()
    await run({ action: 'wait', ms: 700 })
    expect(clock.now()).toBe(700)
    await run({ action: 'wait', until: { visible_text: 'Go' } })
    const failure = run({ action: 'wait', until: { visible_text: 'Never', timeout_ms: 1000 } })
    await expect(failure).rejects.toBeInstanceOf(StepFailure)
    await expect(failure).rejects.toMatchObject({ code: 'EXPECT_FAILED' })
  })
})
