import { expect, test } from '@playwright/test'

// The SPA builds, loads in Chromium and talks to /api (mocked here; later specs start the server).
test('the web app loads and shows the server health', async ({ page }) => {
  await page.route('**/api/health', (route) =>
    route.fulfill({
      json: { status: 'ok', service: 'coral-server', version: '0.1.0', uptime_sec: 42 },
    }),
  )
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'coral', exact: true })).toBeVisible()
  await expect(page.getByText(/version 0\.1\.0/)).toBeVisible()
  await page.screenshot({ path: 'e2e-results/app-shell.png', fullPage: true })
})
