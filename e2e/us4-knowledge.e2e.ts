import type { Page } from '@playwright/test'
import { accessToken, api, expect, ON_EMULATOR, signIn, test } from './fixtures'
import { seedProject } from './seed'

// US4 (T047, quickstart §4): a login skill written in the Knowledge tab, with its test data as
// secrets by name; the Explorer (`fake` brain) types that test data into the Username field, the
// test cases it leads to say `${secret:TEST_USER}`, and nothing the AI was sent holds the value.

interface Exploration {
  id: string
  status: string
  stats: { steps: number; tests_written: number }
}
interface StepView {
  n: number
  decision: { action: string; test_data?: string; secret?: string } | null
  step: { action: string; value?: string } | null
  brain_call_id: string | null
}

const SKILL = `---
name: login-demo-account
description: Log in with the demo account on the Login screen
---
Open the menu, then Log In. Type the username and password test data, then tap Login.
`
const RULES = `schema: coral/skill-rules@1
test_data:
  username: '\${secret:TEST_USER}'
  password: '\${secret:TEST_PASSWORD}'
`
// The values behind the secrets (playwright.config.ts): never in a test case nor an AI call.
const USER = process.env.CORAL_SECRET_TEST_USER ?? 'bod@example.com'
const PASSWORD = process.env.CORAL_SECRET_TEST_PASSWORD ?? '10203040'

/** Replaces an editor's text (no key events: CodeMirror would indent the typed newlines). */
async function setText(page: Page, label: string, text: string) {
  await page.locator(`.cm-content[aria-label="${label}"]`).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(text)
}

test.skip(ON_EMULATOR, 'explored on the emulator by scripts/phase3-explore.mjs')

test('a skill with secret test data leads the Explorer, never its values', async ({
  page,
  account,
  fakeDevice,
}) => {
  test.setTimeout(300_000)
  const token = await accessToken(account)
  const seeded = await seedProject(token)

  // The skill, written in the Knowledge tab and checked as you type.
  await signIn(page, account, `/projects/${seeded.projectId}?tab=knowledge`)
  const nav = page.getByRole('navigation', { name: 'Knowledge files' })
  await expect(nav.getByText('No skill yet.')).toBeVisible()
  await nav.getByRole('button', { name: '+ New skill' }).click()
  await page.getByRole('textbox', { name: 'Name' }).fill('login-demo-account')
  await setText(page, 'SKILL.md', SKILL)
  await setText(page, 'rules.yaml', RULES.replace('test_data', 'test_date'))
  await expect(page.getByRole('alert')).toContainText('test_date')
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
  await page.screenshot({ path: 'e2e-results/us4-knowledge-lint.png', fullPage: true })
  await setText(page, 'rules.yaml', RULES)
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('status')).toContainText('Saved')
  await expect(nav.getByRole('button', { name: 'login-demo-account' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'login-demo-account' })).toBeVisible()
  await page.screenshot({ path: 'e2e-results/us4-knowledge-skill.png', fullPage: true })

  // Explore with it.
  const apps = await api<{ id: string }[]>(`/projects/${seeded.projectId}/apps`, { token })
  const started = await api<Exploration>('/explorations', {
    method: 'POST',
    token,
    body: {
      project_id: seeded.projectId,
      app_id: apps[0]?.id,
      build_id: seeded.buildId,
      device_id: fakeDevice.deviceId,
      budget: { max_steps: 30 },
    },
  })
  await page.goto(`/explorations/${started.id}`)
  await expect(page.getByTestId('exploration-status')).toHaveText(/^(done|stopped)$/, {
    timeout: 240_000,
  })

  // The Username field got the skill's test data: the trace says which secret, not what.
  const trace = await api<StepView[]>(`/explorations/${started.id}/steps?limit=200`, { token })
  const typed = trace.filter((s) => s.decision?.action === 'type')
  expect(typed.map((s) => s.decision?.test_data)).toEqual(
    expect.arrayContaining(['username', 'password']),
  )
  expect(typed.map((s) => s.step?.value)).toEqual(
    expect.arrayContaining(['${secret:TEST_USER}', '${secret:TEST_PASSWORD}']),
  )
  expect(JSON.stringify(trace)).not.toContain(USER)
  expect(JSON.stringify(trace)).not.toContain(PASSWORD)
  for (const step of trace.filter((s) => s.brain_call_id)) {
    const call = await api<{ content: unknown }>(`/brain-calls/${step.brain_call_id}`, { token })
    expect(JSON.stringify(call.content), `AI call of step ${step.n}`).not.toContain(USER)
    expect(JSON.stringify(call.content), `AI call of step ${step.n}`).not.toContain(PASSWORD)
  }

  // The test cases it led to log in with the secret by name.
  const written = await api<{ id: string; slug: string }[]>(
    `/projects/${seeded.projectId}/testcases?source=ai_explore`,
    { token },
  )
  const yamls = await Promise.all(
    written.map(async (t) => (await api<{ yaml: string }>(`/testcases/${t.id}`, { token })).yaml),
  )
  console.log(
    `exploration ${started.id}: ${trace.length} steps, ${written.length} test cases — ` +
      written.map((t) => t.slug).join(', '),
  )
  expect(yamls.some((yaml) => yaml.includes('${secret:TEST_USER}'))).toBe(true)
  for (const yaml of yamls) {
    expect(yaml).not.toContain(USER)
    expect(yaml).not.toContain(PASSWORD)
  }

  // What the AI saw and answered when it typed the username: names only.
  await page.getByRole('tab', { name: 'Trace' }).click()
  const row = page
    .getByRole('table', { name: 'Trace' })
    .getByRole('row')
    .filter({ hasText: 'type test_data username' })
    .first()
  await row.click()
  await expect(page.getByRole('heading', { name: 'What the AI saw' })).toBeVisible()
  await expect(page.getByText('"test_data": "username"')).toBeVisible()
  await expect(page.locator('body')).not.toContainText(USER)
  await page.screenshot({ path: 'e2e-results/us4-knowledge-trace.png', fullPage: true })

  // One of those test cases, in the editor.
  const withSecret = written.filter((_, i) => yamls[i]?.includes('${secret:TEST_USER}'))
  const login = withSecret.find((t) => t.slug.includes('login')) ?? withSecret[0]
  await page.goto(`/projects/${seeded.projectId}/testcases/${login?.id}`)
  await expect(page.getByRole('heading', { name: login?.slug })).toBeVisible()
  // CodeMirror draws the lines in view: scroll down to the step that types the username.
  const editor = page.getByTestId('yaml-editor')
  const secretLine = editor.locator('.cm-line', { hasText: '${secret:TEST_USER}' })
  for (let i = 0; i < 50 && (await secretLine.count()) === 0; i += 1) {
    await editor.locator('.cm-scroller').evaluate((el: { scrollTop: number }) => {
      el.scrollTop += 200
    })
  }
  await secretLine.first().scrollIntoViewIfNeeded()
  await expect(secretLine.first()).toBeVisible()
  await page.screenshot({ path: 'e2e-results/us4-knowledge-testcase.png', fullPage: true })
})
