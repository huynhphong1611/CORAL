import { walkTree, type ElementNode } from '@coral/shared'
import { decode } from 'fast-png'
import { describe, expect, it } from 'vitest'
import { APP, androidTree } from './android-fixtures'
import { FakeDriver, el, windows } from './fake-driver'
import { renderTree } from './render'

const SIZE = { width: 1080, height: 2400 }

function pixel(png: Uint8Array, x: number, y: number): number[] {
  const image = decode(png)
  const i = (Math.round(y) * image.width + Math.round(x)) * image.channels
  return [...image.data.slice(i, i + 3)]
}

function byId(tree: ElementNode[], suffix: string): ElementNode {
  const node = [...walkTree(tree)].find((n) => n.platform_id.endsWith(`:id/${suffix}`))
  if (!node) throw new Error(`no ${suffix}`)
  return node
}

describe('renderTree', () => {
  const login = androidTree('login')
  const png = renderTree(login, SIZE)

  it('writes a PNG of the screen size, or scaled', () => {
    const image = decode(png)
    expect([image.width, image.height, image.channels]).toEqual([1080, 2400, 3])
    const half = decode(renderTree(login, SIZE, { scale: 0.5 }))
    expect([half.width, half.height]).toEqual([540, 1200])
  })

  it('draws clickable nodes and fields apart from the background', () => {
    const background = pixel(png, 1070, 1500)
    const button = byId(login, 'loginBtn').bounds
    // Inside the button, away from its label: the button fill.
    expect(pixel(png, button.x + 4 + 2, button.y + 6)).not.toEqual(background)
    const field = byId(login, 'nameET').bounds
    expect(pixel(png, field.x + 1, field.y + field.h / 2)).not.toEqual(
      pixel(png, field.x + field.w / 2, field.y + 4),
    )
  })

  it('writes text: dark pixels inside a labelled button', () => {
    const button = byId(login, 'loginBtn').bounds
    const image = decode(png)
    let dark = 0
    for (let y = button.y; y < button.y + button.h; y += 1) {
      for (let x = button.x; x < button.x + button.w; x += 1) {
        const i = (y * image.width + x) * 3
        if ((image.data[i] ?? 255) < 80) dark += 1
      }
    }
    expect(dark).toBeGreaterThan(50)
  })

  it('dims the app under a dialog and draws the status bar dark', () => {
    const dialog = renderTree(androidTree('permission-dialog'), SIZE)
    const plain = renderTree(windows(APP, el({ bounds: [0, 0, 1080, 2400] })), SIZE)
    expect(pixel(dialog, 20, 2000)[0]).toBeLessThan(pixel(plain, 20, 2000)[0] ?? 0)
    expect(pixel(png, 1070, 40)[0]).toBeLessThan(60)
  })
})

describe('renderTree text', () => {
  it('keeps curly quotes and Vietnamese readable in ASCII', () => {
    const tree = (text: string) =>
      windows(
        APP,
        el({ bounds: [0, 0, 1080, 2400], children: [el({ text, bounds: [0, 0, 1080, 200] })] }),
      )
    // Same pixels as the plain-ASCII spelling.
    expect(renderTree(tree('Don’t Đăng'), SIZE, { scale: 0.25 })).toEqual(
      renderTree(tree("Don't Dang"), SIZE, { scale: 0.25 }),
    )
  })
})

describe('FakeDriver with renderScreens', () => {
  it('returns the drawn screen and redraws only when the tree changes', async () => {
    const tree = windows(
      APP,
      el({
        bounds: [0, 0, 1080, 2400],
        children: [el({ text: 'Hello', bounds: [0, 100, 1080, 200], clickable: true })],
      }),
    )
    const other = windows(APP, el({ bounds: [0, 0, 1080, 2400] }))
    const driver = new FakeDriver({
      start: 'a',
      screens: { a: { frames: [tree], taps: { Hello: 'b' } }, b: { frames: [other] } },
      renderScreens: { scale: 0.25 },
    })
    const first = await driver.screenshot()
    expect(decode(first).width).toBe(270)
    expect(await driver.screenshot()).toBe(first)
    await driver.tapAt({ x: 540, y: 200 })
    expect(await driver.screenshot()).not.toBe(first)
  })
})
