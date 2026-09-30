import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'
import { E2E_SERVER_URL } from './env'
import { accessToken, api, expect, ON_EMULATOR, signIn, test } from './fixtures'
import { tapDevice } from './live'
import { seedProject } from './seed'

// US4 DoD (quickstart §4): record a login from the browser, accept a suggested expectation, save
// it as `recorded-login`, and replay it 3 times → 3/3 passed. On the drawn fake device (T045) and,
// with CORAL_E2E_DEVICE=emulator, on the Android emulator with the real My Demo App (T046). The
// demo account (research R15) is the server's CORAL_SECRET_TEST_USER / _PASSWORD.

const USER = process.env.CORAL_SECRET_TEST_USER ?? 'bod@example.com'
const PASSWORD = process.env.CORAL_SECRET_TEST_PASSWORD ?? '10203040'
const STEP_MS = ON_EMULATOR ? 30_000 : 15_000
const execFileAsync = promisify(execFile)

interface Node {
  platform_id: string
  text: string
  desc: string
  visible: boolean
  bounds: { x: number; y: number; w: number; h: number }
  children: Node[]
}
interface RecordingView {
  steps: { n: number; step: { id: string }; urls: { tree: string } }[]
}

const walk = (nodes: Node[]): Node[] => nodes.flatMap((n) => [n, ...walk(n.children)])
const center = (n: Node) => ({
  x: Math.round(n.bounds.x + n.bounds.w / 2),
  y: Math.round(n.bounds.y + n.bounds.h / 2),
})
const byId = (id: string) => (n: Node) => n.visible && n.platform_id.endsWith(`:id/${id}`)
const byText = (text: string) => (n: Node) => n.visible && n.text === text

test('records a login from the browser, saves it and replays it 3/3', async ({
  page,
  account,
  fakeDevice,
}) => {
  test.setTimeout(ON_EMULATOR ? 420_000 : 180_000)
  const token = await accessToken(account)
  const seeded = await seedProject(token)
  const steps = page.locator('[data-testid^="step-"]')

  /** Does `action` and waits for the step it records; returns that step's card. */
  async function recorded(action: () => Promise<void>, summary: string | RegExp) {
    const before = await steps.count()
    await action()
    await expect(steps).toHaveCount(before + 1, { timeout: STEP_MS })
    const card = steps.last()
    await expect(card).toContainText(summary)
    return card
  }

  /**
   * Where elements are on the device now: a probe step (Hide keyboard) snapshots the screen, the
   * elements are found in its tree.json, and the probe is deleted again (the delete button).
   */
  async function locate(
    recordingId: string,
    matches: Record<string, (n: Node) => boolean>,
  ): Promise<Record<string, { x: number; y: number }>> {
    const card = await recorded(
      () => page.getByRole('button', { name: 'Hide keyboard' }).click(),
      'hide keyboard',
    )
    const id = ((await card.getAttribute('data-testid')) ?? '').replace('step-', '')
    const recording = await api<RecordingView>(`/recordings/${recordingId}`, { token })
    const probe = recording.steps.find((s) => s.step.id === id)
    if (!probe) throw new Error(`probe ${id} not in the recording`)
    const tree = walk((await (await fetch(probe.urls.tree)).json()) as Node[])
    const found: Record<string, { x: number; y: number }> = {}
    for (const [name, match] of Object.entries(matches)) {
      const node = tree.find(match)
      if (!node) throw new Error(`${name} is not on the screen (probe ${id})`)
      found[name] = center(node)
    }
    await page.getByRole('button', { name: `Delete step ${id}` }).click()
    await expect(page.getByTestId(`step-${id}`)).toHaveCount(0)
    return found
  }

  await signIn(page, account, `/projects/${seeded.projectId}`)
  await page.getByRole('link', { name: 'Record a test case' }).click()
  await expect(page.getByRole('heading', { name: 'Record a test case' })).toBeVisible()
  await page.getByLabel('Device').selectOption(fakeDevice.deviceId)
  await page.getByRole('button', { name: 'Start recording' }).click()
  await expect(page.getByRole('heading', { name: /^Recording / })).toBeVisible({
    timeout: ON_EMULATOR ? 120_000 : 20_000,
  })
  const recordingId = page.url().split('/recordings/')[1] ?? ''
  await expect(page.getByTestId('live-state')).toHaveText('live', { timeout: 15_000 })
  await expect(page.getByTestId('step-s1')).toContainText('launch')
  await page.screenshot({ path: 'e2e-results/us4-started.png', fullPage: true })

  const catalog = await locate(recordingId, { menu: (n) => n.visible && n.desc === 'View menu' })
  await recorded(() => tapDevice(page, catalog.menu ?? { x: 0, y: 0 }), /^.*tap /)
  const menu = await locate(recordingId, { logIn: byText('Log In') })
  await recorded(() => tapDevice(page, menu.logIn ?? { x: 0, y: 0 }), /tap /)
  const form = await locate(recordingId, {
    username: byId('nameET'),
    password: byId('passwordET'),
    login: byId('loginBtn'),
  })
  await recorded(() => tapDevice(page, form.username ?? { x: 0, y: 0 }), 'tap id/nameET')

  // Text equal to a secret is recorded as the secret; only its name comes back.
  await recorded(async () => {
    await page.getByLabel('Type text').fill(USER)
    await page.getByLabel('Type text').press('Enter')
  }, 'type “${secret:TEST_USER}”')
  await expect(page.getByText('The text matched secret TEST_USER')).toBeVisible()
  await recorded(() => tapDevice(page, form.password ?? { x: 0, y: 0 }), 'tap id/passwordET')
  await recorded(async () => {
    await page.getByLabel('Secret').fill('TEST_PASSWORD')
    await page.getByRole('button', { name: 'Type secret' }).click()
  }, 'type “${secret:TEST_PASSWORD}”')
  await recorded(() => page.getByRole('button', { name: 'Hide keyboard' }).click(), 'hide keyboard')
  await page.screenshot({ path: 'e2e-results/us4-login-typed.png', fullPage: true })

  const login = await recorded(
    () => tapDevice(page, form.login ?? { x: 0, y: 0 }),
    'tap id/loginBtn',
  )
  // Accept the first suggested expectation of the login tap (the fake app suggests "Products").
  await login
    .getByRole('button', { name: /^Add expectation/ })
    .first()
    .click()
  await expect(login).toContainText('Expect:')
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

  // SC-009: saved (one commit with the snapshots) within 2 s; it opens in the editor.
  const started = Date.now()
  await page.getByRole('button', { name: 'Save as test case' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${seeded.projectId}/testcases/`))
  await expect(page.getByRole('heading', { name: 'recorded-login' })).toBeVisible()
  const saveMs = Date.now() - started
  console.log(`SC-009: saved recorded-login in ${saveMs} ms`)
  expect(saveMs).toBeLessThan(2000)
  // The editor shows the Recorder's snapshot beside the steps (US5).
  await expect(
    page.getByTestId('picture-s2').getByRole('img', { name: 'Screen of step s2' }),
  ).toBeVisible()
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
  console.log(`recorded-login.yaml:\n${detail.yaml}`)

  // SC-008 (T058): no secret value in the saved YAML, its snap/ trees, or the recording.
  const scan = await execFileAsync(
    process.execPath,
    [
      'scripts/phase1-e2e.mjs',
      '--server',
      E2E_SERVER_URL,
      '--email',
      account.email,
      '--password',
      account.password,
      '--scan-secrets',
      '--test-case',
      saved.id,
      '--recording',
      recordingId,
    ],
    {
      env: {
        PATH: process.env.PATH ?? '',
        CORAL_SECRET_TEST_USER: USER,
        CORAL_SECRET_TEST_PASSWORD: PASSWORD,
      },
    },
  )
  console.log(scan.stdout.trim())
  expect(scan.stdout).toMatch(/for 2 secrets: 0 hits/)

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
    const status = async () => (await api<{ status: string }>(`/runs/${run.id}`, { token })).status
    await expect
      .poll(status, { timeout: ON_EMULATOR ? 120_000 : 45_000, message: `replay ${i}/3` })
      .toMatch(/^(passed|failed|error|cancelled)$/)
    await replayScreenshot(page, run.id, i)
    console.log(`replay ${i}/3 ${run.id}: ${await status()}`)
    expect(await status()).toBe('passed')
  }
})

/** The run page of a replay, kept as evidence (the last one, or any that did not pass). */
async function replayScreenshot(page: Page, runId: string, i: number) {
  await page.goto(`/runs/${runId}`)
  await expect(page.getByRole('heading')).not.toHaveCount(0)
  await page.screenshot({ path: `e2e-results/us4-replay-${i}.png`, fullPage: true })
}
