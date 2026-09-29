import { readFileSync } from 'node:fs'
import { DEFAULT_POPUPS_YAML, parseYaml, popupsSchema, validateTestCaseSource } from '@coral/shared'
import { decode } from 'fast-png'
import { describe, expect, it } from 'vitest'
import { createPopupGuard } from '../core/popup-guard'
import { runTestCase } from '../core/run-testcase'
import { FakeClock } from './fake-clock'
import { FakeDriver } from './fake-driver'
import { SAMPLE_APP, sampleApp } from './sample-app'

const fixture = (name: string) => {
  const source = readFileSync(
    new URL(`../../../../fixtures/testcases/${name}.yaml`, import.meta.url),
    'utf8',
  )
  const parsed = validateTestCaseSource(source, name)
  if (!parsed.value) throw new Error(JSON.stringify(parsed.errors))
  return parsed.value
}

async function run(name: string) {
  const driver = new FakeDriver({ ...sampleApp(), showTyped: true })
  const popups = popupsSchema.parse(parseYaml(DEFAULT_POPUPS_YAML).value)
  const result = await runTestCase({
    driver,
    testCase: fixture(name),
    appId: SAMPLE_APP,
    secrets: { TEST_USER: 'bod@example.com', TEST_PASSWORD: '10203040' },
    popupGuard: createPopupGuard({ popups, driver }),
    clock: new FakeClock(),
  })
  return { driver, result }
}

describe('sample app (My Demo App look-alike)', () => {
  it('passes fixtures/testcases/mydemo-login.yaml like the real app', async () => {
    const { driver, result } = await run('mydemo-login')
    expect(result.status, JSON.stringify(result.steps.at(-1))).toBe('passed')
    expect(result.steps.map((s) => s.step_id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7'])
    // Structured locators match: no fallbacks needed.
    expect(result.steps.filter((s) => s.degraded)).toEqual([])
    expect(driver.current).toBe('catalog')
  })

  it('passes mydemo-camera-permission.yaml with the popup guard allowing the camera', async () => {
    const { result } = await run('mydemo-camera-permission')
    expect(result.status).toBe('passed')
    expect(result.steps.flatMap((s) => s.popups_handled)).toEqual([
      { rule: 'android_permission', button: 'While using the app' },
    ])
  })

  it('shows typed text in the fields and draws the screens', async () => {
    const driver = new FakeDriver({
      ...sampleApp(),
      showTyped: true,
      renderScreens: { scale: 0.5 },
    })
    driver.show('login')
    const before = await driver.screenshot()
    const field = (await driver.tree())
      .flatMap((w) => [w, ...w.children])
      .find((n) => n.platform_id.endsWith('id/nameET'))
    await driver.tapAt({ x: (field?.bounds.x ?? 0) + 10, y: (field?.bounds.y ?? 0) + 10 })
    await driver.type('bod@example.com')
    const typed = (await driver.tree())
      .flatMap((w) => [w, ...w.children])
      .find((n) => n.platform_id.endsWith('id/nameET'))
    expect(typed?.text).toBe('bod@example.com')
    const after = await driver.screenshot()
    expect(after).not.toBe(before)
    expect(decode(after).width).toBe(540)
    await driver.resetApp(SAMPLE_APP)
    expect(driver.typed.size).toBe(0)
  })
})
