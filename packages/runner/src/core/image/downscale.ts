import { rgbToJpeg, SNAPSHOT_JPEG_QUALITY } from '../recorder/crop'
import { decodeToRgb, type RgbImage } from './png'

/** Long edge of the picture sent to the AI: about 1–1.6 thousand tokens (research R6, R7). */
export const AI_IMAGE_MAX_EDGE = 1024
export const AI_JPEG_QUALITY = 70

/**
 * Shrinks so the long edge is at most `maxEdge`, averaging the source pixels each target pixel
 * covers (box filter): text stays readable where nearest-neighbour would drop strokes. Smaller
 * images come back unchanged.
 */
export function downscaleRgb(image: RgbImage, maxEdge: number): RgbImage {
  const { width: w, height: h } = image
  const scale = maxEdge / Math.max(w, h)
  if (scale >= 1) return image
  const tw = Math.max(1, Math.round(w * scale))
  const th = Math.max(1, Math.round(h * scale))
  const out = new Uint8Array(tw * th * 3)
  // Source columns and rows covered by each target column and row.
  const span = (t: number, target: number, source: number) => {
    const from = Math.floor((t * source) / target)
    const to = Math.max(from + 1, Math.floor(((t + 1) * source) / target))
    return [from, Math.min(to, source)] as const
  }
  const cols = Array.from({ length: tw }, (_, x) => span(x, tw, w))
  for (let y = 0; y < th; y += 1) {
    const [y0, y1] = span(y, th, h)
    for (let x = 0; x < tw; x += 1) {
      const [x0, x1] = cols[x] ?? [0, 1]
      let r = 0
      let g = 0
      let b = 0
      for (let sy = y0; sy < y1; sy += 1) {
        let i = (sy * w + x0) * 3
        for (let sx = x0; sx < x1; sx += 1) {
          r += image.data[i] ?? 0
          g += image.data[i + 1] ?? 0
          b += image.data[i + 2] ?? 0
          i += 3
        }
      }
      const n = (y1 - y0) * (x1 - x0)
      const o = (y * tw + x) * 3
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
    }
  }
  return { width: tw, height: th, data: out }
}

/** What `observe` uploads from one lossless screenshot (contracts/agent-ws-phase3.md). */
export interface ObservedImages {
  /** `screen.jpg`: full resolution, for people (trace, app map). */
  screen: Uint8Array
  /** `ai.jpg`: long edge ≤ 1024, for the AI. */
  ai: Uint8Array
  width: number
  height: number
}

export function observedImagesFromPng(png: Uint8Array): ObservedImages {
  const image = decodeToRgb(png)
  return {
    screen: rgbToJpeg(image, SNAPSHOT_JPEG_QUALITY),
    ai: rgbToJpeg(downscaleRgb(image, AI_IMAGE_MAX_EDGE), AI_JPEG_QUALITY),
    width: image.width,
    height: image.height,
  }
}
