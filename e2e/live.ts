import type { Page } from '@playwright/test'

/** The fake device's screen (renderTree of the sample app) in device pixels. */
export const SCREEN = { width: 1080, height: 2400 }

// Runs in the page (e2e/ is type-checked without the DOM library, hence a string): a cheap hash
// of the painted pixels, to see the screen change.
const CANVAS_HASH = `(() => {
  const canvas = document.querySelector('[data-testid="live-canvas"]')
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
  let hash = 0
  for (let i = 0; i < data.length; i += 61) hash = (hash * 31 + data[i]) | 0
  return hash
})()`

export const canvasHash = async (page: Page) => Number(await page.evaluate(CANVAS_HASH))

/** Clicks the live view at a point in device pixels. */
export async function tapDevice(page: Page, point: { x: number; y: number }) {
  const box = await page.getByTestId('live-canvas').boundingBox()
  if (!box) throw new Error('no live view on the page')
  await page.mouse.click(
    box.x + (point.x * box.width) / SCREEN.width,
    box.y + (point.y * box.height) / SCREEN.height,
  )
}

/** Does `action` and returns how long until the painted screen changed (Infinity after `limitMs`). */
export async function timeToChange(page: Page, action: () => Promise<void>, limitMs = 2000) {
  const before = await canvasHash(page)
  const started = Date.now()
  await action()
  while (Date.now() - started <= limitMs) {
    if ((await canvasHash(page)) !== before) return Date.now() - started
    await page.waitForTimeout(25)
  }
  return Number.POSITIVE_INFINITY
}
