import { accessToken, api, expect, ON_EMULATOR, signIn, test } from './fixtures'
import { seedProject } from './seed'

// US3 DoD (SC-001, quickstart §3): explore the drawn My Demo App with the `fake` brain; the Test
// writer turns the trace into test cases and validates each with two runs → at least 3 become
// active. One of them, opened in the editor as `ai_explore`, replays 3 times out of 3.

interface TestCaseSummary {
  id: string
  slug: string
  status: string
  source: string
  source_ref: string | null
  validation: { runs: { status: string }[] } | null
}
interface Exploration {
  id: string
  status: string
  stats: { tests_written: number; tests_active: number }
}

test.skip(ON_EMULATOR, 'explored on the emulator by scripts/phase3-explore.mjs')

test('writes test cases from an exploration, validates them, and one replays 3/3', async ({
  page,
  account,
  fakeDevice,
}) => {
  test.setTimeout(300_000)
  const token = await accessToken(account)
  const seeded = await seedProject(token)
  const apps = await api<{ id: string }[]>(`/projects/${seeded.projectId}/apps`, { token })
  const started = await api<Exploration>('/explorations', {
    method: 'POST',
    token,
    body: {
      project_id: seeded.projectId,
      app_id: apps[0]?.id,
      build_id: seeded.buildId,
      device_id: fakeDevice.deviceId,
      budget: { max_steps: 16 },
    },
  })

  // The exploration's Test cases tab follows the writer, then each validation, live.
  await signIn(page, account, `/explorations/${started.id}?tab=testcases`)
  const status = page.getByTestId('exploration-status')
  await expect(status).toHaveText('validating', { timeout: 90_000 })
  const table = page.getByRole('table', { name: 'Test cases' })
  await expect(table.getByRole('row')).not.toHaveCount(0)
  await page.screenshot({ path: 'e2e-results/us3-validating.png', fullPage: true })
  await expect(status).toHaveText('done', { timeout: 180_000 })
  await expect(table.getByText('2/2 passed').first()).toBeVisible({ timeout: 10_000 })
  await page.screenshot({ path: 'e2e-results/us3-written.png', fullPage: true })

  const exploration = await api<Exploration>(`/explorations/${started.id}`, { token })
  const active = await api<TestCaseSummary[]>(
    `/projects/${seeded.projectId}/testcases?source=ai_explore&status=active`,
    { token },
  )
  console.log(
    `exploration ${started.id}: ${exploration.stats.tests_written} written, ` +
      `${exploration.stats.tests_active} active — ${active.map((t) => t.slug).join(', ')}`,
  )
  expect(active.length).toBeGreaterThanOrEqual(3)
  expect(exploration.stats.tests_active).toBe(active.length)
  for (const testCase of active) {
    expect(testCase.source_ref).toBe(`exploration:${started.id}`)
    expect(testCase.validation?.runs.map((r) => r.status)).toEqual(['passed', 'passed'])
  }

  // Open one in the editor: it says where it came from and how it was validated.
  const chosen = active[0]
  if (!chosen) throw new Error('no active test case')
  await table.getByRole('link', { name: chosen.slug }).click()
  await expect(page.getByRole('heading', { name: chosen.slug })).toBeVisible()
  const panel = page.getByTestId('testcase-status')
  await expect(panel.getByText('AI exploration')).toBeVisible()
  await expect(panel.getByRole('link', { name: /^Exploration / })).toHaveAttribute(
    'href',
    `/explorations/${started.id}?tab=testcases`,
  )
  await expect(panel.getByTestId('validation-runs')).toContainText('Run 1passed')
  await expect(panel.getByTestId('validation-runs')).toContainText('Run 2passed')
  await expect(page.getByTestId('editor-status')).toContainText('Valid')
  await page.screenshot({ path: 'e2e-results/us3-editor.png', fullPage: true })

  // It replays like any test case: 3 times out of 3, no AI involved.
  for (let i = 1; i <= 3; i += 1) {
    const run = await api<{ id: string }>('/runs', {
      method: 'POST',
      token,
      body: {
        project_id: seeded.projectId,
        build_id: seeded.buildId,
        device_id: fakeDevice.deviceId,
        test_case_ids: [chosen.id],
      },
    })
    const runStatus = async () =>
      (await api<{ status: string }>(`/runs/${run.id}`, { token })).status
    await expect
      .poll(runStatus, { timeout: 45_000, message: `replay ${i}/3` })
      .toMatch(/^(passed|failed|error|cancelled)$/)
    console.log(`replay ${i}/3 ${run.id}: ${await runStatus()}`)
    if (i === 3 || (await runStatus()) !== 'passed') {
      await page.goto(`/runs/${run.id}`)
      await expect(page.getByRole('heading')).not.toHaveCount(0)
      await page.screenshot({ path: `e2e-results/us3-replay-${i}.png`, fullPage: true })
    }
    expect(await runStatus()).toBe('passed')
  }
})
