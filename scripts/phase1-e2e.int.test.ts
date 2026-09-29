// T055: scripts/phase1-e2e.mjs against a real server pipeline and the real agent code with a
// FakeDriver (the 🔌 emulator run of T056 uses the same script).
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
let stopAgent: (() => Promise<void>) | undefined

beforeAll(async () => {
  server = await startRunServer({ secrets: { TEST_USER: 'bob@example.com' } })
  huynh = await server.newUser('Huynh')
  dir = await mkdtemp(join(tmpdir(), 'coral-phase1-'))
  await writeFile(join(dir, 'app.apk'), Buffer.from(`apk ${newId()}`))
  await writeFile(join(dir, 'login.yaml'), LOGIN_YAML)
  const token = (await server.newAgent(huynh, 'e2e')).token
  const { agent } = startFakeDeviceAgent({
    serverUrl: server.url,
    token,
    cacheDir: join(dir, 'cache'),
  })
  stopAgent = () => agent.stop()
})
afterAll(async () => {
  await stopAgent?.()
  await server.close()
  await rm(dir, { recursive: true, force: true })
})

const env = {
  PATH: process.env.PATH ?? '',
  CORAL_SECRET_TEST_USER: 'bob@example.com',
}

describe('scripts/phase1-e2e.mjs', () => {
  let lastRun = ''

  it('passes 2/2 runs and checks artifacts and secrets', async () => {
    const args = [
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
      '--runs',
      '2',
      '--scan-secrets',
    ]
    const { stdout } = await run(process.execPath, args, { cwd: dir, env, timeout: 90_000 })
    expect(stdout).toMatch(/run 1\/2 \S+: PASS .*3 steps/)
    expect(stdout).toMatch(/run 2\/2 \S+: PASS/)
    expect(stdout.trim().endsWith('2/2 passed')).toBe(true)
    lastRun = /run 2\/2 (\S+):/.exec(stdout)?.[1] ?? ''

    // Run again: project, app and test case are reused.
    const again = await run(
      process.execPath,
      args.map((a) => (a === '2' ? '1' : a)),
      { cwd: dir, env, timeout: 90_000 },
    )
    expect(again.stdout.trim().endsWith('1/1 passed')).toBe(true)
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
