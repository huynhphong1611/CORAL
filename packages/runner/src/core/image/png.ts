import type { Bounds } from '@coral/shared'
import { decode, encode } from 'fast-png'

/** 8-bit RGB pixels, row by row (what the image matcher and the Recorder's crops work on). */
export interface RgbImage {
  width: number
  height: number
  data: Uint8Array
}

/** Decodes any PNG (grey / RGB, with or without alpha, 8 or 16 bit) to 8-bit RGB. */
export function decodeToRgb(png: Uint8Array): RgbImage {
  const image = decode(png)
  if (image.palette) throw new Error('indexed PNGs are not supported')
  const { width, height, channels } = image
  const source = image.data
  const shift = image.depth === 16 ? 8 : 0
  const data = new Uint8Array(width * height * 3)
  for (let p = 0; p < width * height; p += 1) {
    const at = p * channels
    const grey = channels <= 2
    for (let c = 0; c < 3; c += 1) data[p * 3 + c] = (source[grey ? at : at + c] ?? 0) >> shift
  }
  return { width, height, data }
}

export function encodeRgb(image: RgbImage): Uint8Array {
  return encode({
    width: image.width,
    height: image.height,
    data: image.data,
    channels: 3,
    depth: 8,
  })
}

/** The part of `image` inside `bounds`, clipped to the image; empty bounds throw. */
export function cropRgb(image: RgbImage, bounds: Bounds): RgbImage {
  const x0 = Math.max(0, Math.round(bounds.x))
  const y0 = Math.max(0, Math.round(bounds.y))
  const x1 = Math.min(image.width, Math.round(bounds.x + bounds.w))
  const y1 = Math.min(image.height, Math.round(bounds.y + bounds.h))
  if (x1 <= x0 || y1 <= y0) throw new RangeError('crop is outside the image')
  const width = x1 - x0
  const data = new Uint8Array(width * (y1 - y0) * 3)
  for (let y = y0; y < y1; y += 1) {
    const from = (y * image.width + x0) * 3
    data.set(image.data.subarray(from, from + width * 3), (y - y0) * width * 3)
  }
  return { width, height: y1 - y0, data }
}

/** Crops a PNG to `bounds` and returns a PNG (the Recorder's element.png). */
export function cropPng(png: Uint8Array, bounds: Bounds): Uint8Array {
  return encodeRgb(cropRgb(decodeToRgb(png), bounds))
}
