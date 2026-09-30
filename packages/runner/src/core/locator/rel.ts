import type { Bounds, RelLocator } from '@coral/shared'

export type RelDirection = 'below' | 'above' | 'left_of' | 'right_of'

export function relDirection(rel: RelLocator): RelDirection | undefined {
  if (rel.below) return 'below'
  if (rel.above) return 'above'
  if (rel.left_of) return 'left_of'
  if (rel.right_of) return 'right_of'
  return undefined
}

const overlapsX = (a: Bounds, b: Bounds) => a.x < b.x + b.w && a.x + a.w > b.x
const overlapsY = (a: Bounds, b: Bounds) => a.y < b.y + b.h && a.y + a.h > b.y

/**
 * Gap between `candidate` and `anchor` when the candidate lies entirely on the requested side
 * and overlaps the anchor on the other axis (research R4); undefined otherwise.
 */
export function relDistance(
  direction: RelDirection,
  anchor: Bounds,
  candidate: Bounds,
): number | undefined {
  switch (direction) {
    case 'below':
      return candidate.y >= anchor.y + anchor.h && overlapsX(anchor, candidate)
        ? candidate.y - (anchor.y + anchor.h)
        : undefined
    case 'above':
      return candidate.y + candidate.h <= anchor.y && overlapsX(anchor, candidate)
        ? anchor.y - (candidate.y + candidate.h)
        : undefined
    case 'left_of':
      return candidate.x + candidate.w <= anchor.x && overlapsY(anchor, candidate)
        ? anchor.x - (candidate.x + candidate.w)
        : undefined
    case 'right_of':
      return candidate.x >= anchor.x + anchor.w && overlapsY(anchor, candidate)
        ? candidate.x - (anchor.x + anchor.w)
        : undefined
  }
}
