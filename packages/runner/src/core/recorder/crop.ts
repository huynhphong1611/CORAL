import type { Bounds } from '@coral/shared'
import { encode as encodeJpeg } from 'jpeg-js'
import type { Size } from '../driver'
import { cropRgb, decodeToRgb, encodeRgb, type RgbImage } from '../image/png'

/**
 * `screen.jpg` is for people (editor, step list): a good JPEG is plenty, and far smaller than the
 * PNG of a real screen with photos.
 */
export const SNAPSHOT_JPEG_QUALITY = 80

export interface ScreenSnapshot {
  /** The whole screen as JPEG (`screen.jpg`). */
  screen: Uint8Array
  /** The element's pixels as PNG (`element.png`), when it is on the screenshot. */
  element?: Uint8Array
  /** Screenshot size in pixels. */
  width: number
  height: number
}

/** JPEG of 8-bit RGB pixels (jpeg-js wants RGBA). */
export function rgbToJpeg(image: RgbImage, quality = SNAPSHOT_JPEG_QUALITY): Uint8Array {
  const pixels = image.width * image.height
  const rgba = new Uint8Array(pixels * 4)
  for (let p = 0; p < pixels; p += 1) {
    rgba[p * 4] = image.data[p * 3] ?? 0
    rgba[p * 4 + 1] = image.data[p * 3 + 1] ?? 0
    rgba[p * 4 + 2] = image.data[p * 3 + 2] ?? 0
    rgba[p * 4 + 3] = 255
  }
  const { data } = encodeJpeg({ width: image.width, height: image.height, data: rgba }, quality)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

/**
 * The Recorder's snapshot from one lossless PNG screenshot (research R8): `screen.jpg` and the
 * element cut out at `bounds` as `element.png` — both from the same pixels, and the cut-out free of
 * JPEG artefacts for template matching (R12). `bounds` are in screen units (`screen`); a screenshot
 * of another size is cut at the same place scaled.
 */
export function snapshotFromPng(png: Uint8Array, screen: Size, bounds?: Bounds): ScreenSnapshot {
  const image = decodeToRgb(png)
  const snapshot: ScreenSnapshot = {
    screen: rgbToJpeg(image),
    width: image.width,
    height: image.height,
  }
  if (!bounds) return snapshot
  const sx = image.width / screen.width
  const sy = image.height / screen.height
  try {
    const cut = cropRgb(image, {
      x: bounds.x * sx,
      y: bounds.y * sy,
      w: bounds.w * sx,
      h: bounds.h * sy,
    })
    return { ...snapshot, element: encodeRgb(cut) }
  } catch (error) {
    // Off the screenshot: no cut-out, the chain keeps its structural locators.
    if (error instanceof RangeError) return snapshot
    throw error
  }
}
