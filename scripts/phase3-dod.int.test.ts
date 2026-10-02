// T063: scripts/phase3-dod.mjs end to end against a real server with the `fake` brain and the real
// agent code driving the drawn My Demo App (no AI cost): every criterion runs as on Huynh's machine
// — brains switched by config, a full exploration replayed, the fake OTP MCP server called, an
// import, the secret scan — and report.md lists them.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startRunServer, type RunServer } from '../apps/server/src/testing/run-server'
import { TEST_PASSWORD, type TestUser } from '../apps/server/src/testing/test-server'
import { startSampleDeviceAgent } from './fake-device-agent'

const run = promisify(execFile)
const SCRIPT = new URL('./phase3-dod.mjs', import.meta.url).pathname
const ROOT = new URL('..', import.meta.url).pathname
const PASSWORD = '10203040'

let server: RunServer
let huynh: TestUser
let stopAgent: () => Promise<void> = () => Promise.resolve()
let dir = ''

beforeAll(async () => {
  server = await startRunServer({ explorer: {}, secrets: { TEST_PASSWORD: PASSWORD } })
  huynh = await server.newUser('Huynh')
  dir = await mkdtemp(join(tmpdir(), 'coral-phase3-dod-'))
  // The fake device installs nothing: any bytes make a build.
  await writeFile(join(dir, 'mydemo.apk'), randomBytes(4096))
  const agent = startSampleDeviceAgent({
    serverUrl: server.url,
    token: (await server.newAgent(huynh, 'dod')).token,
    cacheDir: join(dir, 'cache'),
  })
  stopAgent = () => agent.stop()
})
afterAll(async () => {
  await stopAgent()
  await server?.close()
  if (dir) await rm(dir, { recursive: true, force: true })
})

const dod = (...extra: string[]) =>
  run(
    process.execPath,
    [
      SCRIPT,
      ...['--server', server.url, '--email', huynh.email, '--password', TEST_PASSWORD],
      ...['--brains', join(ROOT, 'examples/brains.fake.yaml'), '--switch', 'fake,fake-alt'],
      ...['--apk', join(dir, 'mydemo.apk'), '--no-screenshots'],
      ...extra,
    ],
    {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', CORAL_SECRET_TEST_PASSWORD: PASSWORD },
      timeout: 400_000,
      maxBuffer: 16 << 20,
    },
  )

describe('scripts/phase3-dod.mjs', () => {
  it('runs every criterion with the fake brain and writes the report', async () => {
    const out = join(dir, 'dod')
    const result = await dod(
      ...['--out', out, '--steps', '30', '--min-screens', '4', '--min-active', '1'],
      ...['--replays', '2', '--otp-port', String(3400 + Math.floor(Math.random() * 500))],
      // Two cases are enough here; the DoD itself imports the ten of mydemo-10.csv.
      ...['--csv', join(ROOT, 'fixtures/manual/login-en.csv'), '--min-import-active', '1'],
    ).catch((e: { code: number; stdout: string; stderr: string }) => e)
    const stdout = 'stdout' in result ? result.stdout : ''
    expect(stdout, 'stderr' in result ? result.stderr : '').toMatch(/5\/5 criteria passed/)

    // SC-002: each short exploration answered by the provider the config named.
    expect(stdout).toMatch(/explorer = fake: \d+ steps answered by fake$/m)
    expect(stdout).toMatch(/explorer = fake-alt: \d+ steps answered by fake-alt$/m)
    // SC-001: test cases active and replayed.
    expect(stdout).toMatch(/✅ SC-001/)
    expect(stdout).toMatch(/replay \S+: 2\/2 passed$/m)
    // SC-003: the OTP server's get_otp called for the user name the skill says it gives.
    expect(stdout).toMatch(/tool calls: [1-9]\d* otp__get_otp ok, 0 blocked/)
    // SC-004 and SC-007.
    expect(stdout).toMatch(/✅ SC-004/)
    expect(stdout).toMatch(/for 1 secrets: 0 hits/)

    const report = await readFile(join(out, 'report.md'), 'utf8')
    for (const id of ['SC-002', 'SC-001', 'SC-003', 'SC-004', 'SC-007']) {
      expect(report).toMatch(new RegExp(`^\\| ${id} \\| ✅ \\|`, 'm'))
    }
    const results = JSON.parse(await readFile(join(out, 'results.json'), 'utf8')) as {
      id: string
      explorations: string[]
      imports: string[]
    }[]
    expect(results.find((r) => r.id === 'SC-002')?.explorations).toHaveLength(2)
    expect(results.find((r) => r.id === 'SC-004')?.imports).toHaveLength(1)
  }, 420_000)

  it('stops on usage errors before touching anything', async () => {
    const failed = await run(process.execPath, [SCRIPT, '--server', server.url], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '' },
    }).catch((e: { code: number; stderr: string }) => e)
    expect(failed).toMatchObject({ code: 2 })
    const unknown = await dod('--only', 'sc009').catch((e: { code: number; stderr: string }) => e)
    expect(unknown).toMatchObject({ code: 2 })
    expect('stderr' in unknown ? unknown.stderr : '').toMatch(/unknown section\(s\) sc009/)
  })
})
