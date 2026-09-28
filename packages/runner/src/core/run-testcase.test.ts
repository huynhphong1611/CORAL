import { testCaseSchema, type ElementNode } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../testing/fake-clock'
import { FakeDriver, el, windows } from '../testing/fake-driver'
import type { ArtifactSink, ItemResult, StepFiles } from './artifacts'
import { runTestCase, type PopupGuard, type RunEvent, type RunOptions } from './run-testcase'

const APP = 'com.example'
const login = windows(
  APP,
  el({
    bounds: [0, 0, 1000, 2000],
    children: [
      el({
        platform_id: `${APP}:id/user`,
        class: 'android.widget.EditText',
        clickable: true,
        bounds: [100, 100, 800, 100],
      }),
      el({
        text: 'Đăng nhập',
        class: 'android.widget.Button',
        clickable: true,
        bounds: [100, 300, 800, 100],
      }),
    ],
  }),
)
const home = windows(
  APP,
  el({
    bounds: [0, 0, 1000, 2000],
    children: [el({ text: 'Trang chủ', bounds: [0, 0, 1000, 100] })],
  }),
)
const popup = windows(
  APP,
  el({
    bounds: [0, 0, 1000, 2000],
    children: [el({ text: 'Đăng nhập', clickable: true, bounds: [100, 300, 800, 100] })],
  }),
  el({
    package_or_bundle: 'com.android.permissioncontroller',
    bounds: [0, 0, 1000, 2000],
    children: [el({ text: 'Allow', clickable: true, bounds: [100, 1500, 800, 100] })],
  }),
)

const testCase = (steps: object[], extra: object = {}) =>
  testCaseSchema.parse({
    schema: 'coral/testcase@1',
    id: 'login',
    intent: 'x',
    platforms: ['android'],
    steps,
    ...extra,
  })

const loginSteps = [
  { id: 's1', action: 'launch', expect: { visible_text: 'Đăng nhập' } },
  { id: 's2', action: 'type', target: [{ android_id: 'id/user' }], value: '${secret:TEST_USER}' },
  {
    id: 's3',
    action: 'tap',
    target: [{ text: 'Đăng nhập' }],
    expect: { visible_text: 'Trang chủ' },
  },
]

class MemorySink implements ArtifactSink {
  steps: { testCase: string; index: number; files: StepFiles }[] = []
  results: ItemResult[] = []
  saveStep(testCase: string, step: { index: number }, files: StepFiles) {
    this.steps.push({ testCase, index: step.index, files })
    return Promise.resolve({
      screenshot: `${step.index}/screenshot.png`,
      tree: `${step.index}/tree.json`,
      ...(files.log ? { log: `${step.index}/device.log` } : {}),
    })
  }
  saveResult(result: ItemResult) {
    this.results.push(result)
    return Promise.resolve()
  }
}

function setup(
  screens: Record<string, { frames: ElementNode[][]; taps?: Record<string, string> }>,
  opts: Partial<RunOptions> = {},
) {
  const driver = new FakeDriver({
    screens,
    start: 'login',
    size: { width: 1000, height: 2000 },
    logs: 'E/App: login failed for bob@example.com',
  })
  const sink = new MemorySink()
  const events: RunEvent[] = []
  const run = (tc = testCase(loginSteps)) =>
    runTestCase({
      driver,
      testCase: tc,
      appId: APP,
      secrets: { TEST_USER: 'bob@example.com' },
      sink,
      clock: new FakeClock(),
      onEvent: (e) => events.push(e),
      ...opts,
    })
  return { driver, sink, events, run }
}

describe('runTestCase', () => {
  it('passes a login flow, with evidence for every step and no secret anywhere', async () => {
    const { driver, sink, events, run } = setup({
      login: { frames: [login], taps: { 'Đăng nhập': 'home' } },
      home: { frames: [home] },
    })
    const result = await run()
    expect(result).toMatchObject({ status: 'passed', test_case: 'login' })
    expect(result.steps.map((s) => [s.step_id, s.status, s.locator_used_index])).toEqual([
      ['s1', 'passed', null],
      ['s2', 'passed', 0],
      ['s3', 'passed', 0],
    ])
    expect(driver.calls.find((c) => c.kind === 'type')).toEqual({
      kind: 'type',
      text: 'bob@example.com',
    })
    expect(sink.steps.map((s) => Object.keys(s.files).sort())).toEqual([
      ['screenshot', 'tree'],
      ['screenshot', 'tree'],
      ['screenshot', 'tree'],
    ])
    expect(sink.results).toHaveLength(1)
    expect(events.map((e) => e.type)).toEqual(['step', 'step', 'step', 'item'])
    expect(JSON.stringify({ events, results: sink.results })).not.toContain('bob@example.com')
  })

  it('applies preconditions before the first step', async () => {
    const { driver, run } = setup(
      { login: { frames: [login] } },
      { build: { path: 'app.apk', sha256: 'abc' } },
    )
    await run(
      testCase([{ id: 's1', action: 'launch' }], {
        preconditions: { app_state: 'fresh', grant_permissions: ['camera'] },
      }),
    )
    expect(driver.calls.slice(0, 4).map((c) => c.kind)).toEqual([
      'install',
      'resetApp',
      'grantPermissions',
      'launch',
    ])
  })

  it('fails with TARGET_NOT_FOUND and stops, saving the device log (redacted)', async () => {
    const { sink, run } = setup({ login: { frames: [login] } })
    const result = await run(
      testCase([
        { id: 's1', action: 'tap', target: [{ text: 'Missing' }] },
        { id: 's2', action: 'back' },
      ]),
    )
    expect(result).toMatchObject({ status: 'failed', failure_code: 'TARGET_NOT_FOUND' })
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]?.artifacts.log).toBe('0/device.log')
    expect(sink.steps[0]?.files.log).toBe('E/App: login failed for ***')
  })

  it('fails with EXPECT_FAILED after the timeout', async () => {
    const { run } = setup({ login: { frames: [login] } })
    const result = await run(
      testCase([
        { id: 's1', action: 'assert', expect: { visible_text: 'Trang chủ', timeout_ms: 500 } },
      ]),
    )
    expect(result).toMatchObject({
      status: 'failed',
      failure_code: 'EXPECT_FAILED',
      message: 'text "Trang chủ" is not visible',
    })
  })

  it('marks a step degraded when a later locator matched', async () => {
    const { run } = setup({ login: { frames: [login] } })
    const result = await run(
      testCase([
        {
          id: 's1',
          action: 'tap',
          target: [{ android_id: 'id/old_login' }, { text: 'Đăng nhập' }],
        },
      ]),
    )
    expect(result.steps[0]).toMatchObject({
      status: 'passed',
      locator_used_index: 1,
      degraded: true,
    })
  })

  it('stops when cancelled mid-run', async () => {
    const controller = new AbortController()
    const { run } = setup(
      { login: { frames: [login] } },
      { signal: controller.signal, onEvent: (e) => e.type === 'step' && controller.abort() },
    )
    const result = await run(
      testCase([
        { id: 's1', action: 'back' },
        { id: 's2', action: 'back' },
        { id: 's3', action: 'back' },
      ]),
    )
    expect(result).toMatchObject({ status: 'error', message: 'cancelled' })
    expect(result.steps).toHaveLength(1)
  })

  it('asks the popup guard when the target is covered, then retries', async () => {
    const guard: PopupGuard = {
      handle: (tree) => {
        const covered = tree.some((w) => w.package_or_bundle === 'com.android.permissioncontroller')
        if (!covered) return Promise.resolve(null)
        driver.show('login')
        return Promise.resolve({ rule: 'android_permission', button: 'Allow' })
      },
    }
    const { driver, run } = setup(
      { popup: { frames: [popup] }, login: { frames: [login] } },
      { popupGuard: guard },
    )
    driver.show('popup')
    const result = await run(
      testCase([{ id: 's1', action: 'tap', target: [{ text: 'Đăng nhập' }] }]),
    )
    expect(result.steps[0]).toMatchObject({
      status: 'passed',
      popups_handled: [{ rule: 'android_permission', button: 'Allow' }],
    })
  })

  it('refuses to start on another platform or without secrets', async () => {
    const { driver, run } = setup({ login: { frames: [login] } })
    await expect(run(testCase(loginSteps, { platforms: ['ios'] }))).rejects.toMatchObject({
      code: 'platform_mismatch',
    })
    await expect(
      runTestCase({
        driver,
        testCase: testCase(loginSteps),
        appId: APP,
        secrets: {},
        clock: new FakeClock(),
      }),
    ).rejects.toMatchObject({ code: 'missing_secrets', message: 'missing secrets: TEST_USER' })
    expect(driver.calls).toEqual([])
  })

  it('reports driver exceptions as DRIVER_ERROR', async () => {
    const { driver, run } = setup({ login: { frames: [login] } })
    driver.back = () => Promise.reject(new Error('u2 server gone'))
    const result = await run(testCase([{ id: 's1', action: 'back' }]))
    expect(result).toMatchObject({
      status: 'failed',
      failure_code: 'DRIVER_ERROR',
      message: 'u2 server gone',
    })
  })
})
