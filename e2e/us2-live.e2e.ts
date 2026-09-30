import type { Page } from '@playwright/test'
import { accessToken, api, expect, signIn, test } from './fixtures'
import { seedProject } from './seed'

// US2 (quickstart §3): two browsers watch the fake device at once; a run on it does not stop the
// live view.

/** Frames painted by the page's live view so far (LiveView counts them on the canvas). */
async function framesPainted(page: Page): Promise<number> {
  return Number((await page.getByTestId('live-canvas').getAttribute('data-frames')) ?? 0)
}

/** Frames painted during `ms`. */
async function framesDuring(page: Page, ms: number): Promise<number> {
  const before = await framesPainted(page)
  await page.waitForTimeout(ms)
  return (await framesPainted(page)) - before
}

test('two browsers watch the same device live, also while a run uses it', async ({
  browser,
  account,
  fakeDevice,
}) => {
  const devicePath = `/devices/${fakeDevice.deviceId}`
  const [first, second] = await Promise.all([browser.newContext(), browser.newContext()])
  const a = await first.newPage()
  const b = await second.newPage()
  await signIn(a, account, devicePath)
  await signIn(b, account, devicePath)
  for (const page of [a, b]) {
    await expect(page.getByTestId('live-state')).toHaveText('live', { timeout: 10_000 })
    await expect(page.getByTestId('device-screen')).toHaveText('1080 × 2400')
  }

  // Both keep receiving at least 2 frames a second over 3 s (the agent streams at 4 fps).
  const [countA, countB] = await Promise.all([framesDuring(a, 3000), framesDuring(b, 3000)])
  console.log(`US2: frames painted in 3 s — browser A ${countA}, browser B ${countB}`)
  expect(countA).toBeGreaterThanOrEqual(6)
  expect(countB).toBeGreaterThanOrEqual(6)
  await a.screenshot({ path: 'e2e-results/us2-live-a.png', fullPage: true })
  await b.screenshot({ path: 'e2e-results/us2-live-b.png', fullPage: true })

  // A run takes the device: the view goes on, and shows the screens the run walks through.
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
  await expect(a.getByText(/busy · run/)).toBeVisible({ timeout: 10_000 })
  expect(await framesDuring(a, 1500)).toBeGreaterThanOrEqual(3)
  await a.screenshot({ path: 'e2e-results/us2-live-during-run.png', fullPage: true })
  await expect
    .poll(async () => (await api<{ status: string }>(`/runs/${run.id}`, { token })).status, {
      timeout: 45_000,
    })
    .toBe('passed')
  await expect(a.getByText('idle', { exact: true })).toBeVisible()
  expect(await framesDuring(b, 1500)).toBeGreaterThanOrEqual(3)
  await Promise.all([first.close(), second.close()])
})
