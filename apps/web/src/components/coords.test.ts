import { describe, expect, it } from 'vitest'
import { gesture, LONG_PRESS_MS, toDevice } from './coords'

const portrait = { deviceWidth: 1080, deviceHeight: 2400 }

describe('toDevice (contracts/ui-ws.md)', () => {
  it('scales a point on the rendered frame to device pixels within 1 %', () => {
    // The frame is drawn 360×800 CSS px on the page.
    const rendered = { width: 360, height: 800 }
    expect(toDevice({ x: 180, y: 400 }, rendered, portrait)).toEqual({ x: 540, y: 1200 })
    expect(toDevice({ x: 26.3, y: 55 }, rendered, portrait)).toEqual({ x: 79, y: 165 })
    for (const [x, y] of [
      [0, 0],
      [123.4, 567.8],
      [359, 799],
    ] as const) {
      const device = toDevice({ x, y }, rendered, portrait)
      expect(Math.abs(device.x - (x * 1080) / 360)).toBeLessThanOrEqual(1080 * 0.01)
      expect(Math.abs(device.y - (y * 2400) / 800)).toBeLessThanOrEqual(2400 * 0.01)
    }
  })

  it('keeps points inside the screen', () => {
    expect(toDevice({ x: -5, y: 900 }, { width: 360, height: 800 }, portrait)).toEqual({
      x: 0,
      y: 2399,
    })
  })

  it('uses the size of the frame on screen when the device is rotated', () => {
    const landscape = { deviceWidth: 2400, deviceHeight: 1080 }
    expect(toDevice({ x: 800, y: 180 }, { width: 800, height: 360 }, landscape)).toEqual({
      x: 2400 - 1,
      y: 540,
    })
    expect(toDevice({ x: 400, y: 90 }, { width: 800, height: 360 }, landscape)).toEqual({
      x: 1200,
      y: 270,
    })
  })
})

describe('gesture', () => {
  const identity = (p: { x: number; y: number }) => ({ x: Math.round(p.x), y: Math.round(p.y) })

  it('reads a click as a tap, a long hold as a long press, a drag as a swipe', () => {
    expect(gesture({ x: 10, y: 20, at: 0 }, { x: 12, y: 21, at: 120 }, identity)).toEqual({
      kind: 'tap',
      x: 10,
      y: 20,
    })
    expect(
      gesture({ x: 10, y: 20, at: 0 }, { x: 10, y: 20, at: LONG_PRESS_MS + 100 }, identity),
    ).toEqual({ kind: 'long_press', x: 10, y: 20, ms: 600 })
    expect(gesture({ x: 100, y: 700, at: 0 }, { x: 100, y: 200, at: 250 }, identity)).toEqual({
      kind: 'swipe',
      from: { x: 100, y: 700 },
      to: { x: 100, y: 200 },
      ms: 250,
    })
  })

  it('keeps durations in the range the server accepts', () => {
    expect(gesture({ x: 0, y: 0, at: 0 }, { x: 0, y: 90, at: 5 }, identity)).toMatchObject({
      kind: 'swipe',
      ms: 50,
    })
    expect(gesture({ x: 0, y: 0, at: 0 }, { x: 0, y: 0, at: 60_000 }, identity)).toMatchObject({
      kind: 'long_press',
      ms: 10_000,
    })
  })
})
