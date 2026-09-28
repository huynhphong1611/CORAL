import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeDriver, el, windows } from '@coral/runner/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CliDeps, DeviceRow, RunnableDriver } from '../deps'
import { createProgram } from '../program'
import { secretsFromEnv } from './run'

const APP = 'com.example.app'
const login = windows(
  APP,
  el({
    bounds: [0, 0, 1080, 2400],
    children: [
      el({
        platform_id: `${APP}:id/user`,
        class: 'android.widget.EditText',
        clickable: true,
        bounds: [100, 100, 800, 120],
      }),
      el({
        text: 'Login',
        class: 'android.widget.Button',
        clickable: true,
        bounds: [100, 300, 800, 120],
      }),
    ],
  }),
)
const home = windows(
  APP,
  el({
    bounds: [0, 0, 1080, 2400],
    children: [el({ text: 'Products', bounds: [0, 100, 1080, 100] })],
  }),
)

const TESTCASE = `schema: coral/testcase@1
id: login
intent: 'Đăng nhập'
platforms: [android]
variables:
  user: \${secret:TEST_USER}
steps:
  - id: s1
    action: launch
    expect: { visible_text: 'Login' }
  - id: s2
    action: type
    target: [{ android_id: 'id/user' }]
    value: \${var:user}
  - id: s3
    action: tap
    target: [{ android_id: 'id/old' }, { text: 'Login' }]
    expect: { visible_text: 'Products', timeout_ms: 300 }
`

let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'coral-run-'))
  await writeFile(join(dir, 'login.yaml'), TESTCASE)
  await writeFile(
    join(dir, 'broken.yaml'),
    TESTCASE.replace('products', '').replace('Products', 'Nowhere'),
  )
  await writeFile(
    join(dir, 'ios.yaml'),
    TESTCASE.replace('[android]', '[ios]')
      .replace("android_id: 'id/user'", "ios_id: 'user'")
      .replace("{ android_id: 'id/old' }, ", ''),
  )
  await writeFile(join(dir, 'invalid.yaml'), TESTCASE.replace("intent: 'Đăng nhập'\n", ''))
})
afterAll(() => rm(dir, { recursive: true, force: true }))

function setup(opts: { devices?: DeviceRow[]; env?: Record<string, string> } = {}) {
  const created: string[] = []
  let driver: FakeDriver | undefined
  const deps: CliDeps = {
    env: opts.env ?? { CORAL_SECRET_TEST_USER: 'bob@example.com' },
    now: () => new Date('2026-09-28T10:00:00Z'),
    listDevices: () =>
      Promise.resolve(
        opts.devices ?? [
          {
            udid: 'emulator-5554',
            state: 'device',
            kind: 'emulator',
            model: 'sdk_gphone64',
            os_version: '14',
            api_level: 34,
          },
        ],
      ),
    createDriver: ({ udid }) => {
      created.push(udid)
      driver = new FakeDriver({
        screens: { login: { frames: [login], taps: { Login: 'home' } }, home: { frames: [home] } },
        start: 'login',
      })
      const runnable = Object.assign(driver, {
        open: () => Promise.resolve(),
        close: () => Promise.resolve(),
      })
      return Promise.resolve(runnable as RunnableDriver)
    },
  }
  let out = ''
  let err = ''
  let code: number | undefined
  const run = async (args: string[]) => {
    const program = createProgram(
      { out: (t) => (out += t), err: (t) => (err += t), setExitCode: (c) => (code = c) },
      () => deps,
    )
      .exitOverride()
      .configureOutput({ writeOut: (t) => (out += t), writeErr: (t) => (err += t) })
    try {
      await program.parseAsync(args, { from: 'user' })
    } catch (error) {
      code = (error as { exitCode?: number }).exitCode ?? 2
    }
    return { out, err, code, created, driver }
  }
  return { run }
}

describe('coral run', () => {
  it('runs a test case, prints each step and writes the result folder', async () => {
    const out = join(dir, 'out-pass')
    const result = await setup().run(['run', join(dir, 'login.yaml'), '--app', APP, '--out', out])
    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    expect(result.out).toContain('▶ login  (emulator-5554)')
    expect(result.out).toMatch(/✓ s3 +tap .*\(degraded\)/)
    expect(result.out).toContain('1/1 passed')
    expect((await readdir(join(out, 'login'))).sort()).toEqual([
      '0-s1',
      '1-s2',
      '2-s3',
      'result.json',
    ])
    const saved = await readFile(join(out, 'login', 'result.json'), 'utf8')
    expect(JSON.parse(saved)).toMatchObject({
      status: 'passed',
      steps: [{}, {}, { degraded: true, locator_used_index: 1 }],
    })
    expect(saved).not.toContain('bob@example.com')
    expect(result.driver?.calls.find((c) => c.kind === 'type')).toEqual({
      kind: 'type',
      text: 'bob@example.com',
    })
  })

  it('exits 1 when a test case fails', async () => {
    const result = await setup().run([
      'run',
      join(dir, 'broken.yaml'),
      '--app',
      APP,
      '--out',
      join(dir, 'out-fail'),
    ])
    expect(result.code).toBe(1)
    expect(result.out).toMatch(/✗ s3 .*EXPECT_FAILED/)
  })

  it('prints JSON with --format json', async () => {
    const result = await setup().run([
      'run',
      join(dir, 'login.yaml'),
      '--app',
      APP,
      '--out',
      join(dir, 'out-json'),
      '--format',
      'json',
    ])
    const body = JSON.parse(result.out) as { results: { status: string }[] }
    expect(body.results.map((r) => r.status)).toEqual(['passed'])
  })

  it.each([
    ['a missing secret', ['login.yaml'], { env: {} }, 'missing secrets: CORAL_SECRET_TEST_USER'],
    ['a test case for another platform', ['ios.yaml'], {}, 'platform_mismatch'],
    ['an invalid test case', ['invalid.yaml'], {}, 'invalid test case'],
    [
      'several devices without --device',
      ['login.yaml'],
      {
        devices: [
          { udid: 'a', state: 'device' },
          { udid: 'b', state: 'device' },
        ],
      },
      '--device',
    ],
    [
      'no online device',
      ['login.yaml'],
      { devices: [{ udid: 'a', state: 'unauthorized' }] },
      'no online device',
    ],
  ])('exits 2 before touching a device on %s', async (_name, files, opts, message) => {
    const result = await setup(opts).run(['run', ...files.map((f) => join(dir, f)), '--app', APP])
    expect(result.code).toBe(2)
    expect(result.err).toContain(message)
    expect(result.created).toEqual([])
  })

  it('requires --app', async () => {
    expect((await setup().run(['run', join(dir, 'login.yaml')])).code).toBe(2)
  })

  it('reads secrets from CORAL_SECRET_<NAME>', () => {
    expect(
      secretsFromEnv({ CORAL_SECRET_TEST_USER: 'u', CORAL_SECRET_A_B: 'x', OTHER: 'y' }),
    ).toEqual({ TEST_USER: 'u', A_B: 'x' })
  })
})

describe('coral devices', () => {
  it('prints a table of devices', async () => {
    const result = await setup({
      devices: [
        {
          udid: 'emulator-5554',
          state: 'device',
          kind: 'emulator',
          model: 'sdk_gphone64',
          os_version: '14',
          api_level: 34,
        },
        { udid: 'R58M', state: 'unauthorized' },
      ],
    }).run(['devices'])
    expect(result.code).toBe(0)
    expect(result.out.split('\n')).toEqual([
      'UDID           STATE         KIND      MODEL         ANDROID  API',
      'emulator-5554  device        emulator  sdk_gphone64  14       34',
      'R58M           unauthorized  -         -             -        -',
      '',
    ])
  })
})
