import { describe, expect, it } from 'vitest'
import { renderTree } from '../../testing/render'
import { sampleApp } from '../../testing/sample-app'
import { cropRgb, decodeToRgb } from '../image/png'
import { imageInfo } from '../image/size'
import { snapshotFromPng } from './crop'

const SCREEN = { width: 1080, height: 2400 }
const catalog = sampleApp().screens.catalog?.frames.at(-1) ?? []
const menuButton = { x: 24, y: 110, w: 110, h: 110 }

describe('snapshotFromPng (research R8, T039)', () => {
  it('cuts the element out of the PNG, pixel for pixel, and keeps the screen as JPEG', () => {
    const png = renderTree(catalog, SCREEN)
    const snapshot = snapshotFromPng(png, SCREEN, menuButton)

    expect([...snapshot.screen.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
    expect(imageInfo(snapshot.screen)).toMatchObject({ width: 1080, height: 2400 })
    // A photo-rich real screen is 1–3 MB as PNG; the drawn fake one is flat, so just a budget.
    expect(snapshot.screen.length).toBeLessThan(300_000)
    expect({ width: snapshot.width, height: snapshot.height }).toEqual({
      width: 1080,
      height: 2400,
    })

    const element = decodeToRgb(snapshot.element ?? new Uint8Array())
    expect({ width: element.width, height: element.height }).toEqual({ width: 110, height: 110 })
    expect(element.data).toEqual(cropRgb(decodeToRgb(png), menuButton).data)
  })

  it('cuts at the scaled place when the screenshot is smaller than the screen', () => {
    const half = renderTree(catalog, SCREEN, { scale: 0.5 })
    const snapshot = snapshotFromPng(half, SCREEN, menuButton)
    const element = decodeToRgb(snapshot.element ?? new Uint8Array())
    expect({ width: element.width, height: element.height }).toEqual({ width: 55, height: 55 })
    expect(element.data).toEqual(cropRgb(decodeToRgb(half), { x: 12, y: 55, w: 55, h: 55 }).data)
  })

  it('clips an element partly off screen and skips one entirely off it', () => {
    const png = renderTree(catalog, SCREEN)
    const partly = snapshotFromPng(png, SCREEN, { x: 1000, y: 2300, w: 200, h: 200 })
    expect(imageInfo(partly.element ?? new Uint8Array())).toMatchObject({ width: 80, height: 100 })
    const off = snapshotFromPng(png, SCREEN, { x: 0, y: 2600, w: 100, h: 100 })
    expect(off.element).toBeUndefined()
    expect(off.screen.length).toBeGreaterThan(0)
  })
})
