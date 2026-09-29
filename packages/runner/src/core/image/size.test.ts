import { describe, expect, it } from 'vitest'
import { jpegHeader } from '../../testing/jpeg'
import { encodeRgb } from './png'
import { imageInfo } from './size'

describe('imageInfo', () => {
  it('reads the size of a PNG from IHDR', () => {
    const png = encodeRgb({ width: 540, height: 1200, data: new Uint8Array(540 * 1200 * 3) })
    expect(imageInfo(png)).toEqual({ mime: 'image/png', width: 540, height: 1200 })
  })

  it('reads the size of a baseline or progressive JPEG from its SOF segment', () => {
    expect(imageInfo(jpegHeader(576, 1280))).toEqual({
      mime: 'image/jpeg',
      width: 576,
      height: 1280,
    })
    expect(imageInfo(jpegHeader(1280, 576, true))).toMatchObject({ width: 1280, height: 576 })
  })

  it('returns undefined for anything else, or a file cut short', () => {
    expect(imageInfo(new Uint8Array([1, 2, 3, 4, 5]))).toBeUndefined()
    expect(imageInfo(jpegHeader(10, 10).subarray(0, 24))).toBeUndefined()
    expect(imageInfo(new Uint8Array(0))).toBeUndefined()
  })
})
