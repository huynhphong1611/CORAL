import type { protocol } from '@coral/shared'

export interface Point {
  x: number
  y: number
}

/** Size of the device screen shown by the current frame (its orientation included). */
export interface ScreenSize {
  deviceWidth: number
  deviceHeight: number
}

/**
 * A point on the rendered frame (CSS pixels from its top-left corner) → device pixels
 * (contracts/ui-ws.md): scaled by the device size of the frame on screen, which already reflects
 * the rotation, and kept inside the screen.
 */
export function toDevice(
  point: Point,
  rendered: { width: number; height: number },
  screen: ScreenSize,
): Point {
  const scale = (value: number, from: number, to: number) =>
    Math.min(to - 1, Math.max(0, Math.round((value * to) / from)))
  return {
    x: scale(point.x, rendered.width, screen.deviceWidth),
    y: scale(point.y, rendered.height, screen.deviceHeight),
  }
}

/** Pointer moves shorter than this (CSS px) are a tap, longer ones a swipe. */
export const TAP_SLOP_PX = 8
/** Held at least this long without moving: a long press (US3). */
export const LONG_PRESS_MS = 500

/** What a pointer gesture on the frame means for the device (FR-008). */
export function gesture(
  down: Point & { at: number },
  up: Point & { at: number },
  map: (p: Point) => Point,
): protocol.DeviceCommand {
  const ms = Math.max(0, Math.round(up.at - down.at))
  const moved = Math.hypot(up.x - down.x, up.y - down.y)
  if (moved < TAP_SLOP_PX) {
    const at = map(down)
    return ms >= LONG_PRESS_MS
      ? { kind: 'long_press', ...at, ms: Math.min(10_000, ms) }
      : { kind: 'tap', ...at }
  }
  return {
    kind: 'swipe',
    from: map(down),
    to: map(up),
    ms: Math.min(10_000, Math.max(50, ms)),
  }
}
