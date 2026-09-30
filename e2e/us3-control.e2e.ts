import type { Page } from '@playwright/test'
import { accessToken, api, expect, nameOf, seedAccount, signIn, test } from './fixtures'
import { canvasHash, tapDevice, timeToChange } from './live'
import { seedProject } from './seed'

// US3 (quickstart §3): hold the fake device from the browser, tap through its screens; someone
// else sees who holds it; a run waits until the device is released.

/** "View menu" on the catalog; on the menu the same spot is its "Catalog" item. */
const MENU_TOGGLE = { x: 79, y: 165 }

const tapAndTime = (page: Page, point: { x: number; y: number }) =>
  timeToChange(page, () => tapDevice(page, point))

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

  // Back starts from the catalog whatever the earlier tests left on the device: it closes the
  // menu or leaves the login page of the sample app, and does nothing on the catalog.
  const back = holder.getByRole('button', { name: 'Back', exact: true })
  await timeToChange(holder, () => back.click(), 1500)

  // A click on "View menu" opens the menu on the device, and the new screen shows up — also in
  // the other browser, which only watches.
  expect(await tapAndTime(holder, MENU_TOGGLE)).toBeLessThan(2000)
  const opened = await canvasHash(holder)
  await expect.poll(() => canvasHash(other), { timeout: 5000 }).toBe(opened)
  await holder.screenshot({ path: 'e2e-results/us3-menu-open.png', fullPage: true })
  await other.screenshot({ path: 'e2e-results/us3-controlled-by.png', fullPage: true })

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
