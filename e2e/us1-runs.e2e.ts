import type { Page } from '@playwright/test'
import { accessToken, expect, seedAccount, signIn, test } from './fixtures'
import { seedProject } from './seed'

// US1 (quickstart §2): a project with an app, a build and a 10-step test case for the drawn My
// Demo App; the run is started from the web on the fake device and followed live.
interface Setup {
  projectId: string
  runId: string
}

// Runs in the page (e2e/ is type-checked without the DOM library, hence a string).
const LOADED_STEP_IMAGES = `[...document.querySelectorAll('img[alt^="Screenshot of step"]')]
  .filter((img) => img.complete && img.naturalWidth > 0).length`

/** Step images of the page that have loaded (not broken, not pending). */
async function loadedImages(page: Page): Promise<number> {
  return Number(await page.evaluate(LOADED_STEP_IMAGES))
}

test.describe.serial('US1: runs on the web', () => {
  const setup: Setup = { projectId: '', runId: '' }

  test('runs a test case from the web and follows it live to passed', async ({
    page,
    account,
    fakeDevice,
  }) => {
    setup.projectId = (await seedProject(await accessToken(account))).projectId
    await signIn(page, account, `/projects/${setup.projectId}`)
    await expect(page.getByRole('cell', { name: 'tour', exact: true })).toBeVisible()
    await page.screenshot({ path: 'e2e-results/us1-project.png', fullPage: true })

    await page.getByRole('button', { name: 'Run tour' }).click()
    const dialog = page.getByRole('dialog', { name: 'Run test cases' })
    await dialog.getByLabel('Device').selectOption(fakeDevice.deviceId)
    await expect(dialog.getByLabel('Build')).toContainText('2.2.0')
    await page.screenshot({ path: 'e2e-results/us1-run-dialog.png' })
    await dialog.getByRole('button', { name: 'Start run' }).click()

    await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/)
    setup.runId = page.url().split('/').at(-1) ?? ''
    // No reload: the page follows the run over /ws/ui until it ends.
    await expect(page.getByText('Live')).toBeVisible()
    // Steps appear as the device reports them.
    await expect
      .poll(() => page.getByRole('listitem', { name: /^Step / }).count(), { intervals: [50] })
      .toBeGreaterThanOrEqual(3)
    await page.screenshot({ path: 'e2e-results/us1-run-live.png', fullPage: true })
    await expect(page.getByTestId('run-status')).toHaveText('passed', { timeout: 45_000 })
    await expect(page.getByText('Live')).toBeHidden()
    await expect(page.getByRole('listitem', { name: /^Step / })).toHaveCount(10)
    await expect.poll(() => loadedImages(page), { timeout: 10_000 }).toBe(10)
    await page.screenshot({ path: 'e2e-results/us1-run-detail.png', fullPage: true })

    const submit = page.getByRole('listitem', { name: 'Step submit' })
    await submit.getByRole('button', { name: 'Element tree' }).click()
    await expect(submit.getByRole('list', { name: 'Element tree' })).toContainText('#productTV')
    // Nothing typed leaks into later screens (SC-008): the catalog shows no password.
    await expect(submit.getByRole('list', { name: 'Element tree' })).not.toContainText('10203040')
    await submit.scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'e2e-results/us1-step-tree.png', fullPage: true })
  })

  test('lists the run and shows the device idle again', async ({ page, account, fakeDevice }) => {
    await signIn(page, account, '/runs')
    const row = page.locator(`tr[data-run-id="${setup.runId}"]`)
    await expect(row).toContainText('passed')
    await expect(row).toContainText('tour')
    await page.screenshot({ path: 'e2e-results/us1-runs.png', fullPage: true })

    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Devices' })
      .click()
    const device = page.locator(`tr[data-device-id="${fakeDevice.deviceId}"]`)
    await expect(device).toContainText('coral fake (My Demo App)')
    await expect(device).toContainText('idle')
    await page.screenshot({ path: 'e2e-results/us1-devices.png', fullPage: true })
  })

  test('SC-009: the page of a finished 10-step run shows every image within 3 s', async ({
    page,
    account,
  }) => {
    await signIn(page, account, '/projects')
    const started = Date.now()
    await page.goto(`/runs/${setup.runId}`)
    await expect.poll(() => loadedImages(page), { timeout: 3000, intervals: [50] }).toBe(10)
    const elapsedMs = Date.now() - started
    console.log(`SC-009: run page with 10 step images ready in ${elapsedMs} ms`)
    expect(elapsedMs).toBeLessThanOrEqual(3000)
  })

  test("a user of another tenant gets Not found for the run's URL", async ({ page }) => {
    const other = await seedAccount()
    await signIn(page, other, `/runs/${setup.runId}`)
    await expect(page.getByRole('alert')).toHaveText(/not found/i)
    await expect(page.getByRole('img')).toHaveCount(0)
    await page.screenshot({ path: 'e2e-results/us1-other-tenant.png', fullPage: true })
  })
})
