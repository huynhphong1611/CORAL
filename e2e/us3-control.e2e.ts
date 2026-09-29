import type { Page } from '@playwright/test'
import { accessToken, api, expect, nameOf, seedAccount, signIn, test } from './fixtures'
import { seedProject } from './seed'

// US3 (quickstart §3): hold the fake device from the browser, tap through its screens; someone
// else sees who holds it; a run waits until the device is released.

/** The fake device's screen (renderTree) in device pixels. */
const SCREEN = { width: 1080, height: 2400 }
/** "View menu" on the catalog; on the menu the same spot is its "Catalog" item. */
const MENU_TOGGLE = { x: 79, y: 165 }

// Runs in the page (e2e/ is type-checked without the DOM library, hence a string): a cheap hash
// of the painted pixels, to see the screen change.
const CANVAS_HASH = `(() => {
  const canvas = document.querySelector('[data-testid="live-canvas"]')
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
  let hash = 0
  for (let i = 0; i < data.length; i += 61) hash = (hash * 31 + data[i]) | 0
  return hash
})()`

const canvasHash = async (page: Page) => Number(await page.evaluate(CANVAS_HASH))

/** Clicks the live view at a point in device pixels. */
async function tapDevice(page: Page, point: { x: number; y: number }) {
  const box = await page.getByTestId('live-canvas').boundingBox()
  if (!box) throw new Error('no live view on the page')
  await page.mouse.click(
    box.x + (point.x * box.width) / SCREEN.width,
    box.y + (point.y * box.height) / SCREEN.height,
  )
}

/** Taps and returns how long until the painted screen changed (Infinity after `limitMs`). */
async function tapAndTime(page: Page, point: { x: number; y: number }, limitMs = 2000) {
  const before = await canvasHash(page)
  const started = Date.now()
  await tapDevice(page, point)
  while (Date.now() - started <= limitMs) {
    if ((await canvasHash(page)) !== before) return Date.now() - started
    await page.waitForTimeout(25)
  }
  return Number.POSITIVE_INFINITY
}

test('holds the device from the browser: taps land, others see who, runs wait', async ({
  browser,
  account,
  fakeDevice,
}) => {
  test.setTimeout(120_000)
  const devicePath = `/devices/${fakeDevice.deviceId}`
  const teammate = await seedAccount({ account, role: 'member' })
  const [first, second] = await Promise.all([browser.newContext(), browser.newContext()])
  const holder = await first.newPage()
  const other = await second.newPage()

  await signIn(holder, account, devicePath)
  await expect(holder.getByTestId('live-state')).toHaveText('live', { timeout: 10_000 })
  await holder.getByRole('button', { name: 'Take control' }).click()
  await expect(holder.getByText('You control this device')).toBeVisible()
  await expect(holder.getByTestId('auto-release')).toContainText('Released automatically in')

  await signIn(other, teammate, devicePath)
  await expect(other.getByText(`Controlled by ${nameOf(account)}`, { exact: true })).toBeVisible()
  await expect(other.getByRole('button', { name: 'Take control' })).toBeDisabled()
  await other.screenshot({ path: 'e2e-results/us3-controlled-by.png', fullPage: true })

  // A click on "View menu" opens the menu on the device, and the new screen shows up.
  expect(await tapAndTime(holder, MENU_TOGGLE)).toBeLessThan(2000)
  await holder.screenshot({ path: 'e2e-results/us3-menu-open.png', fullPage: true })

  // SC-002: at least 90 % of 20 clicks show a new screen within 2 s.
  const times: number[] = []
  for (let i = 0; i < 20; i += 1) times.push(await tapAndTime(holder, MENU_TOGGLE))
  const fast = times.filter((ms) => ms <= 2000).length
  const sorted = [...times].sort((a, b) => a - b)
  console.log(
    `SC-002: ${fast}/20 clicks showed a new frame within 2 s ` +
      `(median ${sorted[10]} ms, slowest ${sorted[19]} ms)`,
  )
  expect(fast).toBeGreaterThanOrEqual(18)

  // A run for the held device waits…
  const token = await accessToken(account)
  const seeded = await seedProject(token)
  const run = await api<{ id: string }>('/runs', {
    method: 'POST',
    token,
    body: {
      project_id: seeded.projectId,
      build_id: seeded.buildId,
      device_id: fakeDevice.deviceId,
      test_case_ids: [seeded.testCaseId],
    },
  })
  const status = async () => (await api<{ status: string }>(`/runs/${run.id}`, { token })).status
  await holder.waitForTimeout(2500)
  expect(await status()).toBe('queued')
  await holder.screenshot({ path: 'e2e-results/us3-holding.png', fullPage: true })

  // …and starts once the device is released.
  await holder.getByRole('button', { name: 'Release' }).click()
  await expect(holder.getByRole('button', { name: 'Take control' })).toBeVisible()
  await expect.poll(status, { timeout: 45_000 }).toBe('passed')
  await expect(other.getByText(`Controlled by ${nameOf(account)}`, { exact: true })).toBeHidden()
  await Promise.all([first.close(), second.close()])
})
