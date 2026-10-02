import type { Page } from '@playwright/test'
import { accessToken, api, expect, ON_EMULATOR, signIn, test } from './fixtures'
import { seedProject } from './seed'

// US5 (T049, quickstart §5): a test case from a goal, on the drawn My Demo App with the `fake`
// brain. A goal it can reach → one `ai_prompt` test case of the way there, validated `active`;
// a goal behind Place Order (never_tap) → "Goal not reached" with the AI's reason, no test case.

interface StepView {
  status: string
  refusal: string | null
  step: unknown
}
interface TestCaseSummary {
  id: string
  slug: string
  status: string
  source: string
  intent: string
}

test.skip(ON_EMULATOR, 'the goals are written for the screens the fake device draws')

/** Starts an exploration with this goal from the Explore form; resolves on its page, ended. */
async function exploreWithGoal(page: Page, projectId: string, deviceId: string, goal: string) {
  await page.goto(`/projects/${projectId}/explore`)
  await expect(page.getByRole('heading', { name: 'Explore the app' })).toBeVisible()
  await page.getByLabel('Device').selectOption(deviceId)
  await page.getByLabel('Goal (optional)').fill(goal)
  await expect(page.getByLabel('Max test cases')).toHaveValue('1')
  await page.getByRole('button', { name: 'Start' }).click()
  await expect(page.getByRole('heading', { name: /^Exploration / })).toBeVisible()
  await expect(page.getByTestId('exploration-status')).toHaveText(/^(done|stopped|failed)$/, {
    timeout: 150_000,
  })
  return new URL(page.url()).pathname.split('/').at(-1) ?? ''
}

test('writes a test case from a goal it reaches, none for a goal behind never_tap', async ({
  page,
  account,
  fakeDevice,
}) => {
  test.setTimeout(300_000)
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

  // 1. A goal it can reach: the cart.
  const goal = 'Open the cart until "My Cart"'
  const reachedId = await exploreWithGoal(page, seeded.projectId, fakeDevice.deviceId, goal)
  await expect(page.getByTestId('exploration-status')).toHaveText('done')
  await expect(page.getByTestId('exploration-stop-reason')).toHaveText('Stopped: goal reached')
  const result = page.getByTestId('goal-result')
  await expect(result.getByText('Goal reached', { exact: true })).toBeVisible()
  await expect(result).toContainText('"My Cart" is on the screen')
  const tests = result.getByRole('list', { name: 'Test case from the goal' })
  await expect(tests.getByRole('listitem')).toHaveCount(1)
  await expect(tests.getByText('active')).toBeVisible()
  await page.screenshot({ path: 'e2e-results/us5-prompt-reached.png', fullPage: true })

  const written = await api<TestCaseSummary[]>(
    `/projects/${seeded.projectId}/testcases?source=ai_prompt`,
    { token },
  )
  expect(written).toHaveLength(1)
  expect(written[0]).toMatchObject({ status: 'active', intent: goal })
  const yaml = (await api<{ yaml: string }>(`/testcases/${written[0]?.id}`, { token })).yaml
  console.log(`exploration ${reachedId} → ${written[0]?.slug}:\n${yaml}`)
  // Only the way to the goal: launch, then the tap on the cart that shows "My Cart".
  expect(yaml.match(/action: /g)).toHaveLength(2)
  expect(yaml).toContain('visible_text: My Cart')
  await tests.getByRole('link').click()
  await expect(page.getByRole('heading', { name: written[0]?.slug })).toBeVisible()
  await expect(page.getByTestId('testcase-status')).toContainText('AI from a prompt')
  await page.screenshot({ path: 'e2e-results/us5-prompt-testcase.png', fullPage: true })

  // 2. A goal behind Place Order (never_tap): given up on the cart, never tapped, no test case.
  const forbiddenId = await exploreWithGoal(
    page,
    seeded.projectId,
    fakeDevice.deviceId,
    'Place Order for the cart until "Your order has been placed"',
  )
  await expect(page.getByTestId('exploration-stop-reason')).toHaveText(
    'Stopped: goal not reachable',
  )
  await expect(result.getByText('Goal not reached', { exact: true })).toBeVisible()
  await expect(result).toContainText('The goal needs a forbidden action')
  await expect(result).toContainText('No test case is written')
  await page.screenshot({ path: 'e2e-results/us5-prompt-not-reached.png', fullPage: true })

  const trace = await api<StepView[]>(`/explorations/${forbiddenId}/steps?limit=200`, { token })
  for (const step of trace) expect(JSON.stringify(step.step)).not.toContain('Place Order')
  await page.getByRole('tab', { name: 'Trace' }).click()
  await expect(
    page
      .getByRole('table', { name: 'Trace' })
      .getByRole('row')
      .filter({ hasText: 'goal not reachable' }),
  ).toHaveCount(1)
  await page.screenshot({ path: 'e2e-results/us5-prompt-trace.png', fullPage: true })
  expect(
    await api<TestCaseSummary[]>(`/projects/${seeded.projectId}/testcases?source=ai_prompt`, {
      token,
    }),
  ).toHaveLength(1)
})
