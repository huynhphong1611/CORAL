import type { Page } from '@playwright/test'
import { accessToken, api, expect, ON_EMULATOR, signIn, test } from './fixtures'
import { seedProject } from './seed'

// US1 (T025, quickstart §2): an owner configures the AI brains in the browser — a broken config
// is shown at its line and cannot be saved, a fixed one is saved as written — then switches
// roles.explorer between the two scripted fake providers (`fake`, `fake-alt`: one adapter, two
// names, only with CORAL_BRAIN_FAKE) by configuration alone, and the next exploration's calls show
// up under the new provider in Usage (SC-002).

interface Exploration {
  id: string
  status: string
}
interface UsageRow {
  key: string
  calls: number
}

test.skip(ON_EMULATOR, 'the providers are the scripted fakes of the E2E server')

const config = (explorer: string) => `schema: coral/brains@1
# Who explores and who writes — set from the browser (US1).
roles:
  explorer: { provider: ${explorer}, model: fake }
  writer: { provider: fake, model: fake }
providers:
  fake-alt: { model: fake }
limits:
  max_cost_usd_per_day: 20
  max_cost_usd_per_exploration: 3
`

async function typeConfig(page: Page, text: string) {
  await page.locator('[data-testid="yaml-editor"] .cm-content').click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(text)
}

test('configures the brains in the browser and switches the explorer by config alone', async ({
  page,
  account,
  fakeDevice,
}) => {
  test.setTimeout(240_000)
  const token = await accessToken(account)
  const seeded = await seedProject(token)

  // 1. The platform default applies until the tenant saves its own.
  await signIn(page, account, '/projects')
  await page.getByRole('link', { name: 'AI', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'AI brains' })).toBeVisible()
  await expect(page.getByTestId('brains-source')).toHaveText('Platform default')
  const save = page.getByRole('button', { name: 'Save' })

  // 2. A provider this server does not run, at line 4: shown there, Save locked.
  await typeConfig(page, config('openai'))
  await expect(page.getByRole('alert')).toContainText('Line 4')
  await expect(page.getByRole('alert')).toContainText('unknown_provider')
  await expect(save).toBeDisabled()
  await page.screenshot({ path: 'e2e-results/us1-brains-error.png', fullPage: true })

  // 3. Fixed: saved as written (comments kept).
  await typeConfig(page, config('fake'))
  await expect(page.getByTestId('brains-status')).toContainText('Valid')
  await save.click()
  await expect(page.getByRole('status')).toContainText('Saved')
  await expect(page.getByTestId('brains-source')).toHaveText('This tenant')
  const stored = await api<{ yaml: string }>('/brains/config', { token })
  expect(stored.yaml).toContain('# Who explores and who writes')

  // 4. An exploration per provider: switched by config only, seen in the usage by provider.
  const appId = (await api<{ id: string }[]>(`/projects/${seeded.projectId}/apps`, { token }))[0]
    ?.id
  const explore = async () => {
    const started = await api<Exploration>('/explorations', {
      method: 'POST',
      token,
      body: {
        project_id: seeded.projectId,
        app_id: appId,
        build_id: seeded.buildId,
        device_id: fakeDevice.deviceId,
        budget: { max_steps: 3 },
        max_tests: 1,
      },
    })
    await expect
      .poll(async () => (await api<Exploration>(`/explorations/${started.id}`, { token })).status, {
        timeout: 120_000,
      })
      .toMatch(/^(done|stopped|failed|interrupted)$/)
  }
  const callsOf = async (provider: string) => {
    const usage = await api<{ rows: UsageRow[] }>('/usage/ai?group=provider', { token })
    return usage.rows.find((r) => r.key === provider)?.calls ?? 0
  }

  await explore()
  const fakeCalls = await callsOf('fake')
  expect(fakeCalls).toBeGreaterThan(0)
  expect(await callsOf('fake-alt')).toBe(0)

  await page.reload()
  await typeConfig(page, config('fake-alt'))
  await expect(page.getByTestId('brains-status')).toContainText('Valid')
  await save.click()
  await expect(page.getByRole('status')).toContainText('Saved')
  await explore()
  // The explorer now runs on fake-alt; the writer stayed on fake.
  expect(await callsOf('fake-alt')).toBeGreaterThan(0)

  await page.reload()
  await page.getByRole('tab', { name: 'By provider' }).click()
  const usage = page.getByRole('table', { name: 'Usage' })
  await expect(usage.getByRole('row', { name: /^fake-alt/ })).toBeVisible()
  await expect(usage.getByRole('row', { name: /^fake\b/ }).first()).toBeVisible()
  await expect(page.getByTestId('usage-today')).toContainText('daily limit')
  await page.screenshot({ path: 'e2e-results/us1-brains-usage.png', fullPage: true })
})
