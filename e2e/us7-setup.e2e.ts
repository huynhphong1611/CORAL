import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { E2E_SERVER_URL } from './env'
import { expect, seedAccount, signIn, test } from './fixtures'

// US7 (quickstart §7): from an empty tenant to a device on /devices with the browser only —
// project, app, APK build, agent token (shown once, Copy); coral-agent (the fake device) started
// with that token shows its device; revoking the agent takes it offline.

test('sets up an app, a build and an agent from the browser; the device comes online', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const account = await seedAccount()
  await signIn(page, account, '/projects')

  // Project → app → build.
  const name = `Setup ${randomBytes(2).toString('hex')}`
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByPlaceholder('Project name').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('link', { name }).click()
  await page.getByRole('tab', { name: 'Apps & builds' }).click()
  const newApp = page.getByRole('form', { name: 'New app' })
  await newApp.getByLabel('App name').fill('My Demo App')
  await newApp.getByLabel('Package').fill('com.saucelabs.mydemoapp.android')
  await newApp.getByRole('button', { name: 'Add app' }).click()
  await expect(page.getByRole('heading', { name: 'My Demo App' })).toBeVisible()

  const upload = page.getByRole('form', { name: 'Upload a build of My Demo App' })
  await upload.getByLabel('Version').fill('2.2.0')
  await upload.getByLabel('APK file').setInputFiles({
    name: 'mydemo.apk',
    mimeType: 'application/vnd.android.package-archive',
    buffer: randomBytes(256 * 1024),
  })
  await upload.getByRole('button', { name: 'Upload' }).click()
  await expect(upload.getByRole('status')).toHaveText('Build 2.2.0 uploaded.')
  await expect(page.getByRole('table', { name: 'Builds' })).toContainText('2.2.0')
  await expect(page.getByRole('table', { name: 'Builds' })).toContainText('0.3 MB')
  await page.screenshot({ path: 'e2e-results/us7-apps.png', fullPage: true })

  // Agent token: shown once, copied, then started with it.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Devices' })
    .click()
  await expect(page.getByText(/No devices yet/)).toBeVisible()
  await page.getByRole('button', { name: 'Add agent' }).click()
  await page.getByLabel('Agent name').fill('lab-mac-1')
  await page.getByRole('button', { name: 'Create token' }).click()
  const tokenField = page.getByLabel('Token of lab-mac-1')
  const token = await tokenField.inputValue()
  expect(token).toMatch(/^coral_agt_/)
  await page.getByRole('button', { name: 'Copy' }).click()
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(await page.evaluate('navigator.clipboard.readText()')).toBe(token)
  await page.screenshot({ path: 'e2e-results/us7-token.png', fullPage: true })
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(tokenField).toHaveCount(0)

  const udid = `fake-${randomBytes(3).toString('hex')}`
  const agent = spawn('node', ['--import', 'tsx', 'scripts/dev-fake-device.ts'], {
    env: {
      ...process.env,
      CORAL_SERVER_URL: E2E_SERVER_URL,
      CORAL_AGENT_TOKEN: token,
      CORAL_FAKE_UDID: udid,
      CORAL_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  try {
    // No reload: the device list follows devices.updated.
    const row = page.locator('tr[data-device-id]').filter({ hasText: udid })
    await expect(row).toContainText('coral fake (My Demo App)', { timeout: 20_000 })
    await expect(row).toContainText('idle')
    const agents = page.getByRole('table', { name: 'Agents' })
    await page.reload()
    await expect(agents.getByRole('row').filter({ hasText: 'lab-mac-1' })).toContainText('online')
    await page.screenshot({ path: 'e2e-results/us7-devices.png', fullPage: true })

    // Revoked: disconnected, its device offline.
    page.once('dialog', (dialog) => void dialog.accept())
    await agents.getByRole('button', { name: 'Revoke lab-mac-1' }).click()
    await expect(agents.getByRole('row').filter({ hasText: 'lab-mac-1' })).toContainText('revoked')
    await expect(page.locator('tr[data-device-id]').filter({ hasText: udid })).toContainText(
      'offline',
      { timeout: 20_000 },
    )
  } finally {
    agent.kill('SIGTERM')
  }
})
