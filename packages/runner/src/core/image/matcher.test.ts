import { readFileSync } from 'node:fs'
import { walkTree, type Bounds, type ElementNode } from '@coral/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { ANDROID_FIXTURES, androidTree, APP } from '../../testing/android-fixtures'
import { renderTree } from '../../testing/render'
import { sampleApp } from '../../testing/sample-app'
import { loadOpenCv, openCvMatcher } from './opencv'
import { encodeRgb } from './png'

// SC-005 on the test screens (fixtures/images/ and more drawn here with renderTree): the login
// button's crop is found wherever the button went under a new id, and nothing matches on screens
// without it (0 false matches). Each match takes ≤ 1 s once OpenCV is loaded.
const dir = new URL('../../../../../fixtures/images/', import.meta.url)
const read = (name: string) => new Uint8Array(readFileSync(new URL(name, dir)))
const SIZE = { width: 1080, height: 2400 }
const BUTTON = `${APP}:id/loginBtn`
const THRESHOLD = 0.85
const matcher = openCvMatcher()
const template = read('login-button.png')

beforeAll(async () => {
  await loadOpenCv()
}, 60_000)

/** Finds the button and checks the time it took. */
async function find(screen: Uint8Array, threshold = THRESHOLD, scale?: number) {
  const started = performance.now()
  const match = await matcher.find(screen, template, { threshold, ...(scale ? { scale } : {}) })
  expect(performance.now() - started).toBeLessThan(1000)
  return match
}

const buttonOf = (tree: ElementNode[]) => [...walkTree(tree)].find((n) => n.platform_id === BUTTON)

/** The login screen with the button changed by `change` (a new id unless it says otherwise). */
function editedLogin(change: (button: ElementNode) => void): { png: Uint8Array; bounds: Bounds } {
  const tree = structuredClone(androidTree('login'))
  const button = buttonOf(tree)
  if (!button) throw new Error('no login button')
  button.platform_id = `${APP}:id/signInButton`
  change(button)
  return { png: renderTree(tree, SIZE), bounds: button.bounds }
}

/** The login button moved by `dy` into free space (nothing drawn over it). */
const movedLogin = (dy: number) =>
  editedLogin((button) => {
    button.bounds = { ...button.bounds, y: button.bounds.y + dy }
  })

// Many screens per test; a CI runner is slower than a laptop (each match stays ≤ 1 s).
describe('image matcher (T050, SC-005)', { timeout: 60_000 }, () => {
  it('finds the button on its own screen and after it moved under a new id', async () => {
    expect(await find(read('login-screen.png'))).toMatchObject({
      bounds: { x: 60, y: 920, w: 960, h: 140 },
      score: expect.closeTo(1, 2) as number,
    })
    expect((await find(read('login-moved.png')))?.bounds).toEqual({
      x: 60,
      y: 1160,
      w: 960,
      h: 140,
    })
  })

  it('finds it wherever it moved (≥ 95 % of the drawn screens)', async () => {
    const offsets = [-600, -400, -200, -80, 600, 700, 800, 900, 1000, 1100]
    let found = 0
    for (const dy of offsets) {
      const { png, bounds } = movedLogin(dy)
      const match = await find(png)
      if (match && match.bounds.x === bounds.x && match.bounds.y === bounds.y) found += 1
    }
    expect(found / offsets.length).toBeGreaterThanOrEqual(0.95)
  })

  it('matches nothing where the button is not to be seen (0 false matches)', async () => {
    const screens: [string, Uint8Array][] = [['login-no-button.png', read('login-no-button.png')]]
    // Dialogs over the login screen hide the button: tapping there would hit the dialog.
    const covered = ['anr-dialog', 'crash-dialog', 'never-tap-only-dialog', 'rate-app-dialog']
    for (const file of ANDROID_FIXTURES) {
      const name = file.replace('.xml', '')
      const tree = androidTree(name)
      if (!buttonOf(tree) || covered.includes(name)) screens.push([file, renderTree(tree, SIZE)])
    }
    for (const [name, spec] of Object.entries(sampleApp().screens)) {
      if (name === 'login') continue
      for (const frame of spec.frames) screens.push([`sample ${name}`, renderTree(frame, SIZE)])
    }
    expect(screens.length).toBeGreaterThanOrEqual(12)
    for (const [name, png] of screens) expect(await find(png), name).toBeUndefined()
  })

  it('tells a button of the same style with another label apart (its content differs)', async () => {
    const decoy = editedLogin((button) => {
      button.text = 'Sign up'
    })
    expect(await find(decoy.png)).toBeUndefined()
    // The bottom sheet's button has the login button's style and size, not its label.
    expect(await find(renderTree(androidTree('overlay-bottom-sheet'), SIZE))).toBeUndefined()
  })

  it('resizes the template by screen_width: the place is found, below the threshold it stays unused', async () => {
    const scale = 720 / 1080
    // The bitmap font does not scale linearly (research R12: one resize, no multi-scale search):
    // the right place scores low, so the default threshold refuses it instead of guessing.
    expect(await find(read('login-720.png'), THRESHOLD, scale)).toBeUndefined()
    const loose = await find(read('login-720.png'), 0.3, scale)
    expect(loose?.bounds.x).toBeCloseTo(60 * scale, -1)
    expect(loose?.bounds.y).toBeCloseTo(920 * scale, -1)
    expect([loose?.bounds.w, loose?.bounds.h]).toEqual([640, 93])
  })

  it('never matches a flat template or one larger than the screen', async () => {
    const flat = encodeRgb({ width: 40, height: 20, data: new Uint8Array(40 * 20 * 3).fill(200) })
    expect(
      await matcher.find(read('login-screen.png'), flat, { threshold: THRESHOLD }),
    ).toBeUndefined()
    expect(
      await matcher.find(template, read('login-screen.png'), { threshold: THRESHOLD }),
    ).toBeUndefined()
  })
})
