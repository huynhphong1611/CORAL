import { expect, test } from '@playwright/test'

// The built SPA in Chromium, /api mocked (later specs start the real server and agent).
const session = {
  access_token: 'e2e-token',
  expires_in: 900,
  user: { id: '01890a5d-ac96-774b-bcce-b302099a8057', email: 'huynh@coral.test', name: 'Huynh' },
  tenant: { id: '01890a5d-ac96-774b-bcce-b302099a8058', name: 'coral', role: 'owner' },
}

test('a visitor without a session lands on Sign in', async ({ page }) => {
  await page.route('**/api/auth/refresh', (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: 'unauthorized', message: 'no session' } },
    }),
  )
  await page.goto('/devices')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await expect(page).toHaveURL(/\/login\?next=%2Fdevices/)
  await page.screenshot({ path: 'e2e-results/app-shell-login.png', fullPage: true })
})

test('a returning user keeps the session and sees the navigation', async ({ page }) => {
  await page.route('**/api/auth/refresh', (route) => route.fulfill({ json: session }))
  await page.goto('/')
  await expect(page).toHaveURL(/\/projects$/)
  await expect(page.getByRole('navigation', { name: 'Main' })).toContainText('Projects')
  await expect(page.getByText('Huynh')).toBeVisible()
  await page.screenshot({ path: 'e2e-results/app-shell-projects.png', fullPage: true })
})
