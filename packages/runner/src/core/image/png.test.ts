import { encode } from 'fast-png'
import { describe, expect, it } from 'vitest'
import { cropPng, cropRgb, decodeToRgb, encodeRgb } from './png'

/** 4×3 RGB image whose pixel (x, y) is [x, y, 7]. */
function gradient(): Uint8Array {
  const data = new Uint8Array(4 * 3 * 3)
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 4; x += 1) data.set([x, y, 7], (y * 4 + x) * 3)
  return encode({ width: 4, height: 3, data, channels: 3, depth: 8 })
}

describe('png helpers', () => {
  it('decodes RGB, RGBA and grey PNGs to RGB', () => {
    expect(decodeToRgb(gradient()).data.slice(0, 6)).toEqual(new Uint8Array([0, 0, 7, 1, 0, 7]))
    const rgba = encode({
      width: 1,
      height: 1,
      data: new Uint8Array([9, 8, 7, 128]),
      channels: 4,
      depth: 8,
    })
    expect([...decodeToRgb(rgba).data]).toEqual([9, 8, 7])
    const grey = encode({ width: 1, height: 1, data: new Uint8Array([200]), channels: 1, depth: 8 })
    expect([...decodeToRgb(grey).data]).toEqual([200, 200, 200])
  })

  it('crops, clipping to the image', () => {
    const image = decodeToRgb(gradient())
    const crop = cropRgb(image, { x: 1, y: 1, w: 2, h: 5 })
    expect([crop.width, crop.height]).toEqual([2, 2])
    expect([...crop.data.slice(0, 3)]).toEqual([1, 1, 7])
    expect(() => cropRgb(image, { x: 10, y: 0, w: 2, h: 2 })).toThrow(RangeError)
    const png = cropPng(gradient(), { x: 3, y: 2, w: 1, h: 1 })
    expect([...decodeToRgb(png).data]).toEqual([3, 2, 7])
    expect(decodeToRgb(encodeRgb(image))).toEqual(image)
  })
})
