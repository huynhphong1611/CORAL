import { decode as decodeJpeg } from 'jpeg-js'
import { describe, expect, it } from 'vitest'
import { renderTree } from '../../testing/render'
import { sampleApp } from '../../testing/sample-app'
import { AI_IMAGE_MAX_EDGE, downscaleRgb, observedImagesFromPng } from './downscale'
import { imageInfo } from './size'

const SCREEN = { width: 1080, height: 2400 }

describe('downscaleRgb (research R7)', () => {
  it('averages the source pixels each target pixel covers', () => {
    // 4×2 → long edge 2: each target pixel is the mean of a 2×2 block.
    const data = Uint8Array.from([
      ...[0, 0, 0, 100, 100, 100, 200, 0, 0, 200, 0, 0],
      ...[100, 100, 100, 200, 200, 200, 0, 0, 200, 0, 0, 100],
    ])
    const small = downscaleRgb({ width: 4, height: 2, data }, 2)
    expect({ width: small.width, height: small.height }).toEqual({ width: 2, height: 1 })
    expect([...small.data]).toEqual([100, 100, 100, 100, 0, 75])
  })

  it('keeps an image already small enough', () => {
    const image = { width: 3, height: 1, data: new Uint8Array(9) }
    expect(downscaleRgb(image, 1024)).toBe(image)
  })
})

describe('observedImagesFromPng', () => {
  it('makes screen.jpg at full size and ai.jpg with a long edge of 1024', () => {
    const png = renderTree(sampleApp().screens.catalog?.frames.at(-1) ?? [], SCREEN)
    const images = observedImagesFromPng(png)
    expect({ width: images.width, height: images.height }).toEqual(SCREEN)
    expect(imageInfo(images.screen)).toMatchObject(SCREEN)
    expect(imageInfo(images.ai)).toMatchObject({ width: 461, height: AI_IMAGE_MAX_EDGE })
    const decoded = decodeJpeg(images.ai, { useTArray: true })
    expect({ width: decoded.width, height: decoded.height }).toEqual({ width: 461, height: 1024 })
    expect(images.ai.length).toBeLessThan(images.screen.length)
  })
})
