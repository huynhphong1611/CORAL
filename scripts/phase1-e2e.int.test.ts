// T055: scripts/phase1-e2e.mjs against a real server pipeline and the real agent code with a
// FakeDriver (the 🔌 emulator run of T056 uses the same script).
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { newId } from '@coral/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LOGIN_YAML, startRunServer, type RunServer } from '../apps/server/src/testing/run-server'
import { TEST_PASSWORD, type TestUser } from '../apps/server/src/testing/test-server'
import { FAKE_APP, startFakeDeviceAgent } from './fake-device-agent'

const run = promisify(execFile)
const SCRIPT = new URL('./phase1-e2e.mjs', import.meta.url).pathname

let server: RunServer
let huynh: TestUser
let dir = ''
const stopAgents: (() => Promise<void>)[] = []

beforeAll(async () => {
  server = await startRunServer({ secrets: { TEST_USER: 'bob@example.com' } })
  huynh = await server.newUser('Huynh')
  dir = await mkdtemp(join(tmpdir(), 'coral-phase1-'))
  await writeFile(join(dir, 'app.apk'), Buffer.from(`apk ${newId()}`))
  await writeFile(join(dir, 'login.yaml'), LOGIN_YAML)
  // emulator-5554 plays the login flow; emulator-5556 also shows a permission dialog at launch.
  for (const [udid, permissionPopup] of [
    ['emulator-5554', false],
    ['emulator-5556', true],
  ] as const) {
    const { agent } = startFakeDeviceAgent({
      serverUrl: server.url,
      token: (await server.newAgent(huynh, `e2e-${udid}`)).token,
      cacheDir: join(dir, 'cache', udid),
      udid,
      permissionPopup,
    })
    stopAgents.push(() => agent.stop())
  }
})
afterAll(async () => {
  await Promise.all(stopAgents.map((stop) => stop()))
  await server?.close()
  if (dir) await rm(dir, { recursive: true, force: true })
})

const env = {
  PATH: process.env.PATH ?? '',
  CORAL_SECRET_TEST_USER: 'bob@example.com',
}

const runLogin = (...extra: string[]) =>
  run(
    process.execPath,
    [
      SCRIPT,
      '--server',
      server.url,
      '--email',
      huynh.email,
      '--password',
      TEST_PASSWORD,
      '--apk',
      join(dir, 'app.apk'),
      '--testcase',
      join(dir, 'login.yaml'),
      '--app',
      FAKE_APP,
      ...extra,
    ],
    { cwd: dir, env, timeout: 90_000 },
  )

describe('scripts/phase1-e2e.mjs', () => {
  let lastRun = ''

  it('passes 2/2 runs and checks artifacts and secrets', async () => {
    const args = ['--device', 'emulator-5554', '--runs', '2', '--scan-secrets']
    const { stdout } = await runLogin(...args)
    expect(stdout).toMatch(/run 1\/2 \S+: PASS .*3 steps$/m)
    expect(stdout).toMatch(/run 2\/2 \S+: PASS/)
    expect(stdout.trim().endsWith('2/2 passed')).toBe(true)
    lastRun = /run 2\/2 (\S+):/.exec(stdout)?.[1] ?? ''

    // Run again: project, app and test case are reused; --download keeps the artifacts.
    const downloads = join(dir, 'downloads')
    const again = await runLogin(...args.map((a) => (a === '2' ? '1' : a)), '--download', downloads)
    expect(again.stdout.trim().endsWith('1/1 passed')).toBe(true)
    const runId = /run 1\/1 (\S+):/.exec(again.stdout)?.[1] ?? ''
    const step = (name: string) => join(downloads, runId, 'login', name)
    expect((await readdir(join(downloads, runId, 'login'))).sort()).toEqual([
      '0-s1',
      '1-s2',
      '2-s3',
    ])
    expect((await readFile(step('0-s1/screenshot.png'))).subarray(1, 4).toString()).toBe('PNG')
    expect(JSON.parse(await readFile(step('2-s3/tree.json'), 'utf8'))).toBeInstanceOf(Array)
  }, 120_000)

  it('checks with --expect-popup that the popup guard handled the rule (SC-003)', async () => {
    const handled = await runLogin(
      '--device',
      'emulator-5556',
      '--expect-popup',
      'android_permission',
    )
    expect(handled.stdout).toMatch(
      /run 1\/1 \S+: PASS .*3 steps, popups: s1 android_permission → Allow$/m,
    )
    expect(handled.stdout.trim().endsWith('1/1 passed')).toBe(true)

    const missing = await runLogin(
      '--device',
      'emulator-5554',
      '--expect-popup',
      'android_permission',
    ).then(
      () => undefined,
      (e: { code: number; stdout: string }) => e,
    )
    expect(missing).toMatchObject({ code: 1 })
    expect(missing?.stdout).toMatch(
      /run 1\/1 \S+: FAIL .*3 steps — popup rule android_permission not handled$/m,
    )
  }, 120_000)

  it('scans one run for secrets', async () => {
    const { stdout } = await run(
      process.execPath,
      [
        SCRIPT,
        '--server',
        server.url,
        '--email',
        huynh.email,
        '--password',
        TEST_PASSWORD,
        '--scan-secrets',
        '--run',
        lastRun,
      ],
      { cwd: dir, env, timeout: 30_000 },
    )
    expect(stdout).toMatch(/for 1 secrets: 0 hits/)
  })

  it('exits 2 on usage errors', async () => {
    const failed = await run(process.execPath, [SCRIPT, '--server', server.url], {
      cwd: dir,
      env,
    }).catch((e: { code: number; stderr: string }) => e)
    expect(failed).toMatchObject({ code: 2 })
  })
})
