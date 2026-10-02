import type { Page } from '@playwright/test'
import { E2E_OTP_URL } from './env'
import { accessToken, api, expect, ON_EMULATOR, signIn, test } from './fixtures'
import { seedProject } from './seed'

// US7 (T060, quickstart §7, SC-003): mcp.yaml written in the Knowledge tab names the fake OTP
// server (playwright.config.ts starts it); an exploration with a goal through the Verify Code
// screen reads the code with `otp__get_otp`, types it and gets past; the test case it writes is
// a draft for a person (`needs_human`): a replay cannot ask the tool.

interface StepView {
  n: number
  decision: { action: string; text?: string } | null
  flags: string[]
  brain_call_id: string | null
}
interface TestCaseSummary {
  id: string
  slug: string
  status: string
  draft_reason: string | null
}
interface BrainCall {
  content: { rounds: { tool_calls: { name: string; result: string }[] }[] } | null
}

const MCP_YAML = `schema: coral/mcp@1
servers:
  otp:
    url: ${E2E_OTP_URL}
    headers:
      Authorization: 'Bearer \${secret:OTP_TOKEN}'
    tools:
      get_otp: {}
      send_sms: {}
`
const GOAL =
  'Open the menu, then Verify Code: type the code sent by SMS, tap Verify, until "Code verified"'
const OTP = '482913'

/** Replaces an editor's text (no key events: CodeMirror would indent the typed newlines). */
async function setText(page: Page, label: string, text: string) {
  await page.locator(`.cm-content[aria-label="${label}"]`).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(text)
}

test.skip(ON_EMULATOR, 'the Verify Code screen is drawn by the fake device only')

test('reads an OTP with an allowed MCP tool and drafts the test case for a person', async ({
  page,
  account,
  fakeDevice,
}) => {
  test.setTimeout(300_000)
  const token = await accessToken(account)
  const seeded = await seedProject(token)

  // 1. mcp.yaml in the Knowledge tab: the token by name only.
  await signIn(page, account, `/projects/${seeded.projectId}?tab=knowledge`)
  await page
    .getByRole('navigation', { name: 'Knowledge files' })
    .getByRole('button', { name: 'mcp.yaml' })
    .click()
  await expect(page.getByRole('heading', { name: 'mcp.yaml' })).toBeVisible()
  await setText(
    page,
    'mcp.yaml',
    MCP_YAML.replace("'Bearer ${secret:OTP_TOKEN}'", 'Bearer abc123456789'),
  )
  // A credential typed in clear is flagged.
  await expect(page.getByText(/looks like a credential/)).toBeVisible()
  await setText(page, 'mcp.yaml', MCP_YAML)
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('status')).toContainText('Saved')
  await page.screenshot({ path: 'e2e-results/us7-mcp-knowledge.png', fullPage: true })

  // 2. A goal through the Verify Code screen.
  await page.goto(`/projects/${seeded.projectId}/explore`)
  await expect(page.getByRole('heading', { name: 'Explore the app' })).toBeVisible()
  await page.getByLabel('Device').selectOption(fakeDevice.deviceId)
  await page.getByLabel('Goal (optional)').fill(GOAL)
  await page.getByRole('button', { name: 'Start' }).click()
  await expect(page.getByRole('heading', { name: /^Exploration / })).toBeVisible()
  await expect(page.getByTestId('exploration-status')).toHaveText(/^(done|stopped|failed)$/, {
    timeout: 150_000,
  })
  await expect(page.getByTestId('exploration-stop-reason')).toHaveText('Stopped: goal reached')
  const explorationId = new URL(page.url()).pathname.split('/').at(-1) ?? ''
  const result = page.getByTestId('goal-result')
  await expect(result.getByText('Goal reached', { exact: true })).toBeVisible()
  const tests = result.getByRole('list', { name: 'Test case from the goal' })
  await expect(tests.getByRole('listitem')).toHaveCount(1)
  await expect(tests.getByText('draft')).toBeVisible()
  await page.screenshot({ path: 'e2e-results/us7-mcp-goal.png', fullPage: true })

  // 3. The trace: the code typed is a value from the tool, and the tool call is listed.
  const steps = await api<StepView[]>(`/explorations/${explorationId}/steps?limit=200`, { token })
  const typed = steps.find((s) => s.decision?.action === 'type')
  expect(typed).toMatchObject({ decision: { text: OTP }, flags: ['mcp_value'] })
  const call = await api<BrainCall>(`/brain-calls/${typed?.brain_call_id}`, { token })
  expect(call.content?.rounds[0]?.tool_calls[0]).toMatchObject({
    name: 'otp__get_otp',
    result: OTP,
  })
  await page.getByRole('tab', { name: 'Trace' }).click()
  const trace = page.getByRole('table', { name: 'Trace' })
  const row = trace.getByRole('row').filter({ hasText: 'value from an MCP tool' })
  await expect(row).toHaveCount(1)
  await row.getByText('Value from a tool').click()
  await expect(page.getByText(`otp__get_otp({}) → ${OTP}`)).toBeVisible()
  await page.screenshot({ path: 'e2e-results/us7-mcp-trace.png', fullPage: true })

  // 4. The test case waits for a person: a replay cannot read the code.
  const written = await api<TestCaseSummary[]>(
    `/projects/${seeded.projectId}/testcases?source=ai_prompt`,
    { token },
  )
  expect(written).toHaveLength(1)
  expect(written[0]).toMatchObject({ status: 'draft', draft_reason: 'needs_human' })
  await page.getByRole('tab', { name: 'Test cases' }).click()
  const table = page.getByRole('table', { name: 'Test cases' })
  await expect(table.getByText('needs_human')).toBeVisible()
  await table.getByRole('link', { name: written[0]?.slug }).click()
  await expect(page.getByRole('heading', { name: written[0]?.slug })).toBeVisible()
  await expect(page.getByText(/a value only a person or an MCP tool can give/)).toBeVisible()
  await page.screenshot({ path: 'e2e-results/us7-mcp-testcase.png', fullPage: true })
})
