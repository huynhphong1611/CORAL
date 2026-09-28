import type { Bounds } from '@coral/shared'
import type { Point, Size } from '../driver'

export function center(bounds: Bounds): Point {
  return { x: Math.round(bounds.x + bounds.w / 2), y: Math.round(bounds.y + bounds.h / 2) }
}

export function intersectsScreen(bounds: Bounds, screen: Size): boolean {
  const w = Math.min(bounds.x + bounds.w, screen.width) - Math.max(bounds.x, 0)
  const h = Math.min(bounds.y + bounds.h, screen.height) - Math.max(bounds.y, 0)
  return w > 0 && h > 0
}

export function contains(bounds: Bounds, point: Point): boolean {
  return (
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.w &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.h
  )
}
