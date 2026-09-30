import { describe, expect, it } from 'vitest'
import { FakeClock } from '../testing/fake-clock'
import { FakeDriver, el, windows } from '../testing/fake-driver'
import { structureHash, waitForStable } from './stability'

const APP = 'com.example'
const screen = (y: number, clock = '10:24') =>
  windows(
    APP,
    el({
      bounds: [0, 0, 1080, 2400],
      children: [el({ platform_id: 'id/card', bounds: [0, y, 1080, 300] })],
    }),
    el({
      package_or_bundle: 'com.android.systemui',
      bounds: [0, 0, 1080, 80],
      children: [el({ text: clock, bounds: [40, 10, 160, 60] })],
    }),
  )

describe('structureHash', () => {
  it('ignores text and sub-4px jitter but not movement', () => {
    expect(structureHash(screen(500, '10:24'))).toBe(structureHash(screen(501, '10:25')))
    expect(structureHash(screen(500))).not.toBe(structureHash(screen(600)))
  })
})

describe('waitForStable', () => {
  it('returns after two identical dumps 300 ms apart', async () => {
    const driver = new FakeDriver({
      screens: { a: { frames: [screen(900), screen(700), screen(500)] } },
      start: 'a',
    })
    const clock = new FakeClock()
    const result = await waitForStable(driver, clock)
    expect(result.unstable).toBe(false)
    expect(clock.sleeps).toEqual([300, 300, 300])
    expect(structureHash(result.tree)).toBe(structureHash(screen(500)))
  })

  it('gives up after the timeout and flags the step unstable', async () => {
    const frames = Array.from({ length: 40 }, (_, i) => screen(100 + i * 20))
    const driver = new FakeDriver({ screens: { a: { frames } }, start: 'a' })
    const clock = new FakeClock()
    const result = await waitForStable(driver, clock)
    expect(result.unstable).toBe(true)
    expect(clock.now()).toBe(3000)
  })

  it('stops when cancelled', async () => {
    const driver = new FakeDriver({ screens: { a: { frames: [screen(1)] } }, start: 'a' })
    const controller = new AbortController()
    controller.abort()
    await expect(
      waitForStable(driver, new FakeClock(), { signal: controller.signal }),
    ).rejects.toThrow('cancelled')
  })
})
