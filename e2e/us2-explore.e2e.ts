import { accessToken, api, expect, ON_EMULATOR, signIn, test } from './fixtures'
import { seedProject } from './seed'

// US2 (T035, quickstart §3): explore the drawn My Demo App with the `fake` brain — progress live
// in the browser, the app map of its screens, a trace with no step on Place Order and the trap
// screen's tap refused as never_tap, what the AI saw and answered; then Stop within 15 s.

interface StepView {
  n: number
  status: string
  refusal: string | null
  step: unknown
}
interface Exploration {
  id: string
  status: string
  stop_reason: string | null
  stats: { steps: number; screens: number; refused: number }
}

test.skip(ON_EMULATOR, 'the trap screen is drawn by the fake device only')

test('explores the app live, maps its screens and refuses the trap', async ({
  page,
  account,
  fakeDevice,
}) => {
  test.setTimeout(180_000)
  const token = await accessToken(account)
  const seeded = await seedProject(token)
  // Place Order is never to be tapped by anything a machine decides (P6, §9.4).
  const popups = await api<{ yaml: string; head_commit: string }>(
    `/projects/${seeded.projectId}/popups`,
    { token },
  )
  await api(`/projects/${seeded.projectId}/popups`, {
    method: 'PUT',
    token,
    body: {
      yaml: popups.yaml.replace("never_tap: ['Mua',", "never_tap: ['Place Order', 'Mua',"),
      base_commit: popups.head_commit,
    },
  })

  await signIn(page, account, `/projects/${seeded.projectId}?tab=explorations`)
  await expect(page.getByText('No explorations yet.')).toBeVisible()
  await page.getByRole('link', { name: 'Explore', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Explore the app' })).toBeVisible()
  await page.getByLabel('Device').selectOption(fakeDevice.deviceId)
  await page.getByLabel('Steps').fill('25')
  await page.screenshot({ path: 'e2e-results/us2-explore-start.png', fullPage: true })
  await page.getByRole('button', { name: 'Start' }).click()

  // Live progress: the step count moves while the page is open (no reload).
  await expect(page.getByRole('heading', { name: /^Exploration / })).toBeVisible()
  const explorationId = new URL(page.url()).pathname.split('/').at(-1) ?? ''
  const steps = page.getByTestId('exploration-steps')
  await expect(steps).toHaveText(/^([3-9]|1\d|2[0-5]) \/ 25$/, { timeout: 30_000 })
  await expect(page.getByTestId('exploration-current')).toBeVisible()
  await expect(page.getByTestId('exploration-cost')).toHaveText(/^\$\d+\.\d\d \/ \$3\.00$/)
  await page.screenshot({ path: 'e2e-results/us2-explore-progress.png', fullPage: true })

  await expect(page.getByTestId('exploration-status')).toHaveText('done', { timeout: 90_000 })
  await expect(steps).toHaveText('25 / 25')
  await expect(page.getByTestId('exploration-stop-reason')).toHaveText('Stopped: step budget used')

  // The app map: the sample app's screens, each with its picture.
  await page.getByRole('tab', { name: 'App map' }).click()
  const cards = page.getByRole('list', { name: 'App map' }).getByRole('listitem')
  await expect(cards).not.toHaveCount(0)
  expect(await cards.count()).toBeGreaterThanOrEqual(4)
  await expect(page.getByRole('list', { name: 'Transitions' })).toContainText('→')
  await page.screenshot({ path: 'e2e-results/us2-explore-appmap.png', fullPage: true })

  // The trace: no step on Place Order, the trap screen's tap refused as never_tap.
  const trace = await api<StepView[]>(`/explorations/${explorationId}/steps?limit=200`, { token })
  expect(trace).toHaveLength(25)
  for (const step of trace) expect(JSON.stringify(step.step)).not.toContain('Place Order')
  const refused = trace.filter((s) => s.status === 'refused')
  expect(refused.map((s) => s.refusal)).toEqual(['never_tap'])

  await page.getByRole('tab', { name: 'Trace' }).click()
  const table = page.getByRole('table', { name: 'Trace' })
  await expect(table.getByRole('row')).toHaveCount(26)
  const trap = table.getByRole('row').filter({ hasText: 'refused: never_tap' })
  await expect(trap).toHaveCount(1)
  await page.screenshot({ path: 'e2e-results/us2-explore-trace.png', fullPage: true })
  await trap.click()
  await expect(page.getByRole('heading', { name: 'What the AI saw' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'What the AI answered' })).toBeVisible()
  await expect(page.getByText('The screen says to tap it', { exact: false }).first()).toBeVisible()
  await expect(page.getByAltText('What the AI saw')).toBeVisible()
  await page.screenshot({ path: 'e2e-results/us2-explore-ai-content.png', fullPage: true })

  // The project lists it with its cost against the budget.
  await page.goto(`/projects/${seeded.projectId}?tab=explorations`)
  const row = page.getByRole('table', { name: 'Explorations' }).getByRole('row').nth(1)
  await expect(row).toContainText('done')
  await expect(row).toContainText('step budget used')
})

test('stops an exploration within 15 s', async ({ page, account, fakeDevice }) => {
  test.setTimeout(120_000)
  const token = await accessToken(account)
  const seeded = await seedProject(token)
  const started = await api<Exploration>('/explorations', {
    method: 'POST',
    token,
    body: {
      project_id: seeded.projectId,
      app_id: (await api<{ id: string }[]>(`/projects/${seeded.projectId}/apps`, { token }))[0]?.id,
      build_id: seeded.buildId,
      device_id: fakeDevice.deviceId,
      budget: { max_steps: 400 },
    },
  })
  await signIn(page, account, `/explorations/${started.id}`)
  await expect(page.getByTestId('exploration-steps')).toHaveText(/^([3-9]|\d\d+) \/ 400$/, {
    timeout: 30_000,
  })
  const asked = Date.now()
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByTestId('exploration-status')).toHaveText('stopped', { timeout: 15_000 })
  expect(Date.now() - asked).toBeLessThan(15_000)
  await expect(page.getByTestId('exploration-stop-reason')).toHaveText(
    'Stopped: stopped by a person',
  )
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  // The device is free again.
  await expect
    .poll(async () => {
      const devices = await api<{ id: string; activity: { kind: string } }[]>('/devices', {
        token,
      })
      return devices.find((d) => d.id === fakeDevice.deviceId)?.activity.kind
    })
    .toBe('idle')
})
