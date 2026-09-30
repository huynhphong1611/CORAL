import { accessToken, expect, signIn, test } from './fixtures'
import { E2E_SERVER_URL } from './env'

// The whole stack: built SPA → /api proxy → coral-server (Postgres, Redis, MinIO) ← fake agent.
test('signs in against the real server and keeps the session on reload', async ({
  page,
  account,
}) => {
  await signIn(page, account, '/devices')
  await expect(page).toHaveURL(/\/devices$/)
  await expect(page.getByText(account.email.split('@')[0] ?? '')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
  await page.screenshot({ path: 'e2e-results/smoke-signed-in.png', fullPage: true })
})

test('the fake device agent comes online for the tenant', async ({ account, fakeDevice }) => {
  const token = await accessToken(account)
  const res = await fetch(`${E2E_SERVER_URL}/devices`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const devices = (await res.json()) as { id: string; model: string }[]
  expect(devices.find((d) => d.id === fakeDevice.deviceId)?.model).toBe('coral fake (My Demo App)')
})
