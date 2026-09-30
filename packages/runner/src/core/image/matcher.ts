import type { Bounds } from '@coral/shared'
import type { RgbImage } from './png'

export interface MatchOptions {
  /** Lowest similarity accepted, 0.5–1 (SPEC §7.2: 0.85 by default). */
  threshold: number
  /** Resize factor of the template before matching: current screen width / `screen_width`. */
  scale?: number
}

export interface Match {
  /** Where the template matched on the screen, in screen pixels. */
  bounds: Bounds
  /** Similarity of the best place, −1…1 (normalised correlation). */
  score: number
}

/**
 * Finds a reference image on a screenshot (the `image` locator, FR-021): the best place, if it is
 * at least `threshold` alike; undefined otherwise (also when the template does not fit).
 */
export interface ImageMatcher {
  find(screen: Uint8Array, template: Uint8Array, options: MatchOptions): Promise<Match | undefined>
}

/** 8-bit luma of RGB pixels (ITU-R BT.601 weights, integer maths). */
export function toGrey(image: RgbImage): Uint8Array {
  const grey = new Uint8Array(image.width * image.height)
  const { data } = image
  for (let p = 0, i = 0; p < grey.length; p += 1, i += 3) {
    grey[p] = ((data[i] ?? 0) * 77 + (data[i + 1] ?? 0) * 150 + (data[i + 2] ?? 0) * 29) >> 8
  }
  return grey
}
