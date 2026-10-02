import { accessToken, api, expect, ON_EMULATOR, signIn, test } from './fixtures'
import { seedProject } from './seed'

// US6 DoD (T056, SC-004, quickstart §6): import fixtures/manual/mydemo-10.csv — 10 manual test
// cases of My Demo App in Vietnamese — on the fake device with the `fake` brain. The preview
// shows the cases read; the job works through them one by one; at least 7 become active test
// cases, the others stay draft with why (a code by SMS, steps that say too little, an expected
// total the app never shows). Resuming after a restart is covered by imports.int.test.ts.

interface ImportJob {
  status: string
  items: {
    n: number
    title: string
    status: string
    reason: string | null
    test_case_id: string | null
    evidence: { message: string } | null
  }[]
  report: { total: number; active: number } | null
}

test.skip(ON_EMULATOR, 'the cases are written for the screens the fake device draws')

test('imports 10 manual test cases: at least 7 active, the others draft with why', async ({
  page,
  account,
  fakeDevice,
}) => {
  test.setTimeout(600_000)
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

  // The file read into a preview: columns guessed from the Vietnamese headers, 10 cases.
  await signIn(page, account, `/projects/${seeded.projectId}?tab=imports`)
  await expect(page.getByText('No imports yet.', { exact: false })).toBeVisible()
  await page.getByRole('link', { name: 'Import test cases' }).click()
  await expect(page.getByRole('heading', { name: 'Import manual test cases' })).toBeVisible()
  await page.getByLabel('File').setInputFiles('fixtures/manual/mydemo-10.csv')
  await page.getByRole('button', { name: 'Read the file' }).click()
  await expect(page.getByTestId('import-cases-count')).toHaveText('10 test cases read')
  await expect(page.getByRole('combobox', { name: 'Title' })).toHaveValue('1')
  const cases = page.getByRole('table', { name: 'Test cases read' })
  await expect(cases).toContainText('Đăng nhập bằng tài khoản demo')
  await expect(cases).toContainText('Mở menu, chọn "Log In"')
  await page.screenshot({ path: 'e2e-results/us6-import-preview.png', fullPage: true })

  // Started on the fake device: the job page follows it.
  await page.getByLabel('Device').selectOption(fakeDevice.deviceId)
  await page.getByRole('button', { name: 'Start' }).click()
  await expect(page.getByRole('heading', { name: 'Import mydemo-10.csv' })).toBeVisible()
  const importId = new URL(page.url()).pathname.split('/').at(-1) ?? ''
  await expect(page.getByTestId('import-progress')).toHaveText(/^[1-9]\d* \/ 10$/, {
    timeout: 120_000,
  })
  await page.screenshot({ path: 'e2e-results/us6-import-running.png', fullPage: true })
  await expect(page.getByTestId('import-status')).toHaveText('done', { timeout: 480_000 })
  await expect(page.getByTestId('import-report')).toContainText(/\d+ of 10 test cases active/)
  await page.screenshot({ path: 'e2e-results/us6-import-report.png', fullPage: true })

  const job = await api<ImportJob>(`/imports/${importId}`, { token })
  console.log(
    job.items
      .map((i) => `${i.n}. ${i.title}: ${i.status} ${i.reason ?? ''} ${i.evidence?.message ?? ''}`)
      .join('\n'),
  )
  expect(job.report?.total).toBe(10)
  expect(job.report?.active).toBeGreaterThanOrEqual(7)
  // Every case not active says why.
  for (const item of job.items.filter((i) => i.status !== 'active')) {
    expect(item.status, item.title).toBe('draft')
    expect(item.reason, item.title).not.toBeNull()
    expect(item.evidence?.message, item.title).toBeTruthy()
  }
  const reasonOf = (n: number) => job.items.find((i) => i.n === n)?.reason
  expect([reasonOf(8), reasonOf(9), reasonOf(10)]).toEqual([
    'needs_human',
    'ambiguous',
    'app_mismatch',
  ])

  // An active one in the editor: it came from the import and passed its validation runs.
  const login = job.items.find((i) => i.n === 3)
  expect(login?.status).toBe('active')
  await page.goto(`/projects/${seeded.projectId}/testcases/${login?.test_case_id}`)
  const panel = page.getByTestId('testcase-status')
  await expect(panel.getByText('AI from an import')).toBeVisible()
  await expect(panel.getByTestId('validation-runs')).toContainText('Run 2passed')
  await page.screenshot({ path: 'e2e-results/us6-import-testcase.png', fullPage: true })
  const testCases = await api<{ source: string }[]>(
    `/projects/${seeded.projectId}/testcases?source=ai_import&status=active`,
    { token },
  )
  expect(testCases.length).toBe(job.report?.active)
})
