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
import { sampleDevice, sampleProject } from '../apps/server/src/testing/sample-project'
import { TEST_PASSWORD, type TestUser } from '../apps/server/src/testing/test-server'
import { FAKE_APP, startFakeDeviceAgent } from './fake-device-agent'

const run = promisify(execFile)
const SCRIPT = new URL('./phase1-e2e.mjs', import.meta.url).pathname

let server: RunServer
let huynh: TestUser
let dir = ''
const stopAgents: (() => Promise<void>)[] = []

beforeAll(async () => {
  // The Explorer (fake brain) too, for the Phase 3 scans; its test cases are not validated.
  server = await startRunServer({
    secrets: { TEST_USER: 'bob@example.com' },
    explorer: { validate: false },
  })
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
      'result.json',
    ])
    expect(JSON.parse(await readFile(step('result.json'), 'utf8'))).toEqual({
      status: 'passed',
      failure_code: null,
      message: null,
    })
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

  it('scans a saved test case and its snapshots (T058, SC-008)', async () => {
    const project = (
      await server.call(huynh, { method: 'POST', url: '/projects', payload: { name: 'scan' } })
    ).body as { id: string }
    const tree = (text: string) => JSON.stringify([{ ref: '0', text, children: [] }])
    await server.store.commitFiles(huynh.tenantId, project.id, {
      files: {
        'snap/clean/s1/screen.jpg': Buffer.from([0xff, 0xd8, 0xff]),
        'snap/clean/s1/tree.json': tree('Products'),
        // A snapshot that kept the typed secret: the scan must find it.
        'snap/leaky/s1/screen.jpg': Buffer.from([0xff, 0xd8, 0xff]),
        'snap/leaky/s1/tree.json': tree('bob@example.com'),
      },
      author: { name: 'Huynh', email: 'huynh@example.com' },
      message: 'snapshots',
    })
    const save = async (slug: string) =>
      (
        (
          await server.call(huynh, {
            method: 'POST',
            url: `/projects/${project.id}/testcases`,
            payload: { yaml: LOGIN_YAML.replace('id: login', `id: ${slug}`) },
          })
        ).body as { id: string }
      ).id
    const scan = (id: string) =>
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
          '--scan-secrets',
          '--test-case',
          id,
        ],
        { cwd: dir, env, timeout: 30_000 },
      )
    const clean = await scan(await save('clean'))
    expect(clean.stdout).toMatch(/scanned 3 documents of test case \S+ for 1 secrets: 0 hits/)
    const leaky = await scan(await save('leaky')).catch((e: { code: number; stdout: string }) => e)
    expect(leaky).toMatchObject({ code: 1 })
    expect(leaky.stdout).toMatch(/: 1 hits\n {2}CORAL_SECRET_TEST_USER: 1/)
  })

  it('scans an exploration: what the AI saw and answered, trace, app map, test cases (T062, SC-007)', async () => {
    const get = async <T>(url: string) =>
      (await server.call(huynh, { method: 'GET', url })).body as T
    // The sample app on a device the server's test agent draws (the Explorer needs real pictures).
    const { project, app, build } = await sampleProject(server, huynh)
    const { sample, deviceId } = await sampleDevice(server, huynh, 'scan-explore')
    stopAgents.push(() => Promise.resolve(sample.close()))
    // A login skill: the Explorer types the username by name; the device shows its value.
    const base = (await get<{ head_commit: string }>(`/projects/${project.id}/agents-md`))
      .head_commit
    const skill = await server.call(huynh, {
      method: 'PUT',
      url: `/projects/${project.id}/skills/login-demo-account`,
      payload: {
        skill_md:
          '---\nname: login-demo-account\ndescription: Log in with the demo account on the Login screen\n---\nOpen the menu, then Log In.\n',
        rules_yaml: "schema: coral/skill-rules@1\ntest_data:\n  username: '${secret:TEST_USER}'\n",
        base_commit: base,
      },
    })
    expect(skill.status).toBe(200)
    const started = await server.explorations.start(
      { tenantId: huynh.tenantId, userId: huynh.userId },
      {
        project_id: project.id,
        app_id: app.id,
        build_id: build.id,
        device_id: deviceId,
        budget: { max_steps: 20 },
      },
    )
    const deadline = Date.now() + 90_000
    for (;;) {
      const { status } = await get<{ status: string }>(`/explorations/${started.id}`)
      if (!['queued', 'running', 'writing', 'validating'].includes(status)) break
      if (Date.now() > deadline) throw new Error(`exploration still ${status}`)
      await new Promise((r) => setTimeout(r, 200))
    }
    const steps = await get<{ step: { action: string; value?: string } | null }[]>(
      `/explorations/${started.id}/steps?limit=200`,
    )
    expect(steps.map((s) => s.step?.value)).toContain('${secret:TEST_USER}')

    const scan = (extraEnv: Record<string, string> = {}) =>
      run(
        process.execPath,
        [
          SCRIPT,
          ...['--server', server.url, '--email', huynh.email, '--password', TEST_PASSWORD],
          ...['--scan-secrets', '--exploration', started.id],
        ],
        { cwd: dir, env: { ...env, ...extraEnv }, timeout: 60_000 },
      )
    const clean = await scan()
    expect(clean.stdout).toMatch(/documents of exploration \S+ for 1 secrets: 0 hits/)
    const documents = Number(/scanned (\d+) documents/.exec(clean.stdout)?.[1])
    // The trace, every step's brain call, the app map with its trees, the test cases.
    expect(documents).toBeGreaterThan(steps.length)
    // A text the app shows, taken as a secret: the scan reads what the trace and the AI saw.
    const probe = await scan({ CORAL_SECRET_PROBE: 'View menu' }).catch(
      (e: { code: number; stdout: string }) => e,
    )
    expect(probe).toMatchObject({ code: 1 })
    expect(probe.stdout).toMatch(/^ {2}CORAL_SECRET_PROBE: \d+$/m)
    expect(probe.stdout).not.toMatch(/CORAL_SECRET_TEST_USER/)
  }, 120_000)

  it('exits 2 on usage errors', async () => {
    const failed = await run(process.execPath, [SCRIPT, '--server', server.url], {
      cwd: dir,
      env,
    }).catch((e: { code: number; stderr: string }) => e)
    expect(failed).toMatchObject({ code: 2 })
  })
})
