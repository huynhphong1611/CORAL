import type { Page } from '@playwright/test'
import { accessToken, api, expect, signIn, test } from './fixtures'
import { seedProject, TOUR } from './seed'

// US5 (quickstart §5): open a test case in the editor, change a step's timeout_ms and save (a new
// commit on top of History); a YAML error shows on its line within 1 s and locks Save; two tabs
// saving the same test case → the later one is told about the conflict and keeps its edits.

/** Replaces the editor's text (no key events: CodeMirror would indent the typed newlines). */
async function setText(page: Page, text: string) {
  await page.locator('[data-testid="yaml-editor"] .cm-content').click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(text)
}

/** A line of the editor (CodeMirror draws the lines in view; the first ones always are). */
const line = (page: Page, n: number) =>
  page.locator('[data-testid="yaml-editor"] .cm-line').nth(n - 1)
const INTENT = 3

test('edits a test case: save as a commit, errors lock Save, two tabs conflict', async ({
  page,
  account,
  fakeDevice,
}) => {
  test.setTimeout(120_000)
  const token = await accessToken(account)
  const seeded = await seedProject(token)

  // One run of the tour, so the editor has a picture for each step (no Recorder snapshots).
  const run = await api<{ id: string }>('/runs', {
    method: 'POST',
    token,
    body: {
      project_id: seeded.projectId,
      build_id: seeded.buildId,
      device_id: fakeDevice.deviceId,
      test_case_ids: [seeded.testCaseId],
    },
  })
  await expect
    .poll(async () => (await api<{ status: string }>(`/runs/${run.id}`, { token })).status, {
      timeout: 60_000,
    })
    .toBe('passed')

  await signIn(page, account, `/projects/${seeded.projectId}`)
  await page.getByRole('link', { name: 'tour', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'tour' })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/testcases/${seeded.testCaseId}$`))
  await expect(line(page, INTENT)).toHaveText(TOUR.split('\n')[INTENT - 1] ?? '')
  const open = page.getByTestId('picture-open')
  await expect(open.getByRole('img', { name: 'Screen of step open' })).toBeVisible()
  await expect(open).toContainText(`Run ${run.id.slice(-8)}`)
  await expect(page.getByText('Valid', { exact: true })).toBeVisible()
  await page.screenshot({ path: 'e2e-results/us5-editor.png', fullPage: true })

  // A YAML error: on its line within 1 s of the last keystroke, Save locked.
  const tooShort = TOUR.replace(
    "expect: { visible_text: 'Log In' }",
    "expect: { visible_text: 'Log In', timeout_ms: 5 }",
  )
  const typed = Date.now()
  await setText(page, tooShort)
  const errors = page.getByRole('list', { name: 'Errors' })
  await expect(errors).toContainText('Line 15:', { timeout: 1000 })
  console.log(`US5: error shown ${Date.now() - typed} ms after the edit`)
  await expect(errors).toContainText('menu')
  await expect(page.locator('.cm-lint-marker-error')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
  // The problem's place takes the editor to that line.
  await errors.getByRole('button', { name: /^Line 15:/ }).click()
  await expect(page.locator('.cm-activeLine')).toContainText('timeout_ms: 5')
  await page.screenshot({ path: 'e2e-results/us5-invalid.png', fullPage: true })

  // Fixed: timeout_ms 8000 on that step → Save → a new commit on top of History.
  const slower = TOUR.replace(
    "expect: { visible_text: 'Log In' }",
    "expect: { visible_text: 'Log In', timeout_ms: 8000 }",
  )
  await setText(page, slower)
  await expect(page.getByText('Valid', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/^Saved/)).toBeVisible()
  await page.getByRole('button', { name: 'History' }).click()
  const history = page.getByRole('list', { name: 'History' })
  await expect(history.getByRole('listitem')).toHaveCount(2)
  await expect(history.getByRole('listitem').first()).toContainText('current')
  const detail = await api<{ yaml: string; head_commit: string }>(
    `/testcases/${seeded.testCaseId}`,
    { token },
  )
  expect(detail.yaml).toBe(slower)
  await expect(history.getByRole('listitem').first()).toContainText(detail.head_commit.slice(0, 7))
  await page.screenshot({ path: 'e2e-results/us5-saved.png', fullPage: true })

  // Two tabs: the first saves, the second (opened on the same version) is told, keeps its text.
  const other = await page.context().newPage()
  other.on('dialog', (dialog) => void dialog.accept())
  await other.goto(page.url())
  await expect(line(other, INTENT)).toHaveText(slower.split('\n')[INTENT - 1] ?? '')
  const first = slower.replace("intent: 'Browse", "intent: 'Tab one: browse")
  const second = slower.replace("intent: 'Browse", "intent: 'Tab two: browse")
  await setText(page, first)
  await setText(other, second)
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/^Saved/)).toBeVisible()
  await expect(other.getByRole('button', { name: 'Save' })).toBeEnabled()
  await other.getByRole('button', { name: 'Save' }).click()
  await expect(other.getByText(/^Changed by someone else/)).toBeVisible()
  await expect(line(other, INTENT)).toContainText('Tab two')
  await other.keyboard.press('ControlOrMeta+Home')
  await other.screenshot({ path: 'e2e-results/us5-conflict.png', fullPage: true })

  await other.getByRole('button', { name: 'Load latest version' }).click()
  await expect(line(other, INTENT)).toContainText('Tab one')
  await expect(other.getByText(/^Changed by someone else/)).toBeHidden()
  const commits = await api<{ commit: string }[]>(`/testcases/${seeded.testCaseId}/history`, {
    token,
  })
  expect(commits).toHaveLength(3)
})
