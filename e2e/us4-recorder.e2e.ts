import { accessToken, api, expect, signIn, test } from './fixtures'
import { tapDevice } from './live'
import { seedProject } from './seed'

// US4 DoD, simulated (quickstart §4, T045): record a login on the fake device from the browser,
// accept a suggested expectation, save it as `recorded-login`, and replay it 3 times → 3/3 passed.
// The demo account (research R15) is the server's CORAL_SECRET_TEST_USER / _PASSWORD.

const USER = process.env.CORAL_SECRET_TEST_USER ?? 'bod@example.com'
const PASSWORD = process.env.CORAL_SECRET_TEST_PASSWORD ?? '10203040'

/** Centres of the sample app's elements, in device pixels (packages/runner/src/testing). */
const AT = {
  menu: { x: 79, y: 165 },
  logInItem: { x: 350, y: 1370 },
  username: { x: 540, y: 545 },
  password: { x: 540, y: 785 },
  loginButton: { x: 540, y: 990 },
}

test('records a login from the browser, saves it and replays it 3/3', async ({
  page,
  account,
  fakeDevice,
}) => {
  test.setTimeout(180_000)
  const token = await accessToken(account)
  const seeded = await seedProject(token)

  await signIn(page, account, `/projects/${seeded.projectId}`)
  await page.getByRole('link', { name: 'Record a test case' }).click()
  await expect(page.getByRole('heading', { name: 'Record a test case' })).toBeVisible()
  await page.getByLabel('Device').selectOption(fakeDevice.deviceId)
  await page.getByRole('button', { name: 'Start recording' }).click()
  await expect(page.getByRole('heading', { name: /^Recording / })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('live-state')).toHaveText('live', { timeout: 10_000 })
  await expect(page.getByTestId('step-s1')).toContainText('launch')
  await page.screenshot({ path: 'e2e-results/us4-started.png', fullPage: true })

  /** Clicks the device and waits for the step it records. */
  async function tap(point: { x: number; y: number }, stepId: string, summary: string) {
    await tapDevice(page, point)
    await expect(page.getByTestId(`step-${stepId}`)).toContainText(summary, { timeout: 15_000 })
  }
  await tap(AT.menu, 's2', 'tap id/menuIV')
  await tap(AT.logInItem, 's3', 'tap text “Log In”')
  await tap(AT.username, 's4', 'tap id/nameET')

  // Text equal to a secret is recorded as the secret; only its name comes back.
  await page.getByLabel('Type text').fill(USER)
  await page.getByLabel('Type text').press('Enter')
  await expect(page.getByTestId('step-s5')).toContainText('type “${secret:TEST_USER}”')
  await expect(page.getByText('The text matched secret TEST_USER')).toBeVisible()
  await tap(AT.password, 's6', 'tap id/passwordET')
  await page.getByLabel('Secret').fill('TEST_PASSWORD')
  await page.getByRole('button', { name: 'Type secret' }).click()
  await expect(page.getByTestId('step-s7')).toContainText('type “${secret:TEST_PASSWORD}”')
  await page.screenshot({ path: 'e2e-results/us4-login-typed.png', fullPage: true })

  await tap(AT.loginButton, 's8', 'tap id/loginBtn')
  await page.getByRole('button', { name: 'Add expectation text “Products” to s8' }).click()
  await expect(page.getByTestId('step-s8')).toContainText('Expect: text “Products”')
  await page.screenshot({ path: 'e2e-results/us4-steps.png', fullPage: true })

  await page.getByLabel('Slug').fill('recorded-login')
  await page.getByLabel('Intent').fill('Đăng nhập bằng tài khoản demo rồi thấy danh sách sản phẩm')
  await page.getByRole('button', { name: 'Preview YAML' }).click()
  const preview = page.getByTestId('yaml-preview')
  await expect(preview).toContainText('id: recorded-login')
  await expect(preview).toContainText('intent: Đăng nhập bằng tài khoản demo')
  await expect(preview).toContainText('${secret:TEST_PASSWORD}')
  const yamlText = (await preview.textContent()) ?? ''
  expect(yamlText).not.toContain(USER)
  expect(yamlText).not.toContain(PASSWORD)
  await page.screenshot({ path: 'e2e-results/us4-preview.png', fullPage: true })

  // SC-009: saved (one commit with the snapshots) within 2 s.
  const started = Date.now()
  await page.getByRole('button', { name: 'Save as test case' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${seeded.projectId}\\?tab=testcases`))
  const row = page.getByRole('row').filter({ hasText: 'recorded-login' })
  await expect(row).toContainText('recorder')
  const saveMs = Date.now() - started
  console.log(`SC-009: saved recorded-login in ${saveMs} ms`)
  expect(saveMs).toBeLessThan(2000)
  await page.screenshot({ path: 'e2e-results/us4-saved.png', fullPage: true })

  const testCases = await api<{ id: string; slug: string }[]>(
    `/projects/${seeded.projectId}/testcases`,
    { token },
  )
  const saved = testCases.find((t) => t.slug === 'recorded-login')
  if (!saved) throw new Error('recorded-login not saved')
  const detail = await api<{ yaml: string }>(`/testcases/${saved.id}`, { token })
  expect(detail.yaml).toContain('${secret:TEST_USER}')
  expect(detail.yaml).not.toContain(USER)
  expect(detail.yaml).not.toContain(PASSWORD)

  // The recorded test case replays 3 times out of 3.
  for (let i = 1; i <= 3; i += 1) {
    const run = await api<{ id: string }>('/runs', {
      method: 'POST',
      token,
      body: {
        project_id: seeded.projectId,
        build_id: seeded.buildId,
        device_id: fakeDevice.deviceId,
        test_case_ids: [saved.id],
      },
    })
    await expect
      .poll(async () => (await api<{ status: string }>(`/runs/${run.id}`, { token })).status, {
        timeout: 45_000,
        message: `replay ${i}/3`,
      })
      .toBe('passed')
    if (i === 3) {
      await page.goto(`/runs/${run.id}`)
      await expect(page.getByText('passed').first()).toBeVisible()
      await page.screenshot({ path: 'e2e-results/us4-replay.png', fullPage: true })
    }
  }
})
