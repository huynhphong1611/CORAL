// T036: scripts/phase3-explore.mjs against a real server with the `fake` brain and an agent whose
// device is the sample app (the 🔌 emulator run uses the same script on My Demo App).
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { SAMPLE_APP } from '@coral/runner/testing'
import { newId } from '@coral/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deviceAgent, type DeviceAgent } from '../apps/server/src/testing/device-agent'
import { startRunServer, type RunServer } from '../apps/server/src/testing/run-server'
import { TEST_PASSWORD, type TestUser } from '../apps/server/src/testing/test-server'

const run = promisify(execFile)
const SCRIPT = new URL('./phase3-explore.mjs', import.meta.url).pathname

let server: RunServer
let huynh: TestUser
let agent: DeviceAgent
let dir = ''

beforeAll(async () => {
  // The writer drafts test cases; validating them needs runs no agent here answers.
  server = await startRunServer({ explorer: { validate: false } })
  huynh = await server.newUser('Huynh')
  dir = await mkdtemp(join(tmpdir(), 'coral-phase3-'))
  await writeFile(join(dir, 'app.apk'), Buffer.from(`apk ${newId()}`))
  agent = await deviceAgent(server.url, (await server.newAgent(huynh, 'explore')).token, {
    udid: 'emulator-5554',
  })
})
afterAll(async () => {
  agent?.close()
  await server?.close()
  if (dir) await rm(dir, { recursive: true, force: true })
})

const explore = (...extra: string[]) =>
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
      '--app',
      SAMPLE_APP,
      ...extra,
    ],
    { cwd: dir, env: { PATH: process.env.PATH ?? '' }, timeout: 90_000 },
  )

describe('scripts/phase3-explore.mjs', () => {
  it('explores, checks screens, activities and never_tap, keeps pictures and test cases', async () => {
    const downloads = join(dir, 'explore')
    const { stdout } = await explore(
      ...['--steps', '16', '--download', downloads],
      ...['--never-tap', 'Log Out', '--never-tap', 'Place Order'],
    )
    expect(stdout).toMatch(/: done \(max_steps\) — 16 steps, \d+ screens .* 1 refused/)
    expect(stdout).toMatch(/screen \S+ [0-9a-f]{16} \.catalog$/m)
    expect(stdout.trim().endsWith('PASS')).toBe(true)
    // What the Test writer made of it, listed with its validation (none here: drafts).
    const written = /^test cases: (\d+) written, 0 active$/m.exec(stdout)
    expect(Number(written?.[1])).toBeGreaterThanOrEqual(3)
    expect(stdout).toMatch(/^ {2}open-\S+: draft — validation none$/m)
    // 'Log out' was already there (labels compare like the popup guard); Place Order, the sample
    // app's trap, joined never_tap: refused, never tapped.
    const popups = (await server.call(huynh, { method: 'GET', url: '/projects' })).body as {
      id: string
      name: string
    }[]
    const project = popups.find((p) => p.name === 'phase3-explore')
    const file = (
      await server.call(huynh, { method: 'GET', url: `/projects/${project?.id}/popups` })
    ).body as { yaml: string }
    expect(file.yaml).toMatch(/never_tap: \[.*'Log out', 'Place Order'\]$/m)
    expect(file.yaml).not.toContain('Log Out')
    expect((await readdir(join(downloads, 'appmap'))).length).toBeGreaterThanOrEqual(4)
    expect(await readdir(join(downloads, 'trace'))).toHaveLength(16)
    expect(await readdir(join(downloads, 'trace'))).toContain('014-refused.jpg')
    expect(await readdir(join(downloads, 'testcases'))).toHaveLength(Number(written?.[1]))
  }, 120_000)

  it('fails when the exploration found fewer screens or active test cases than wanted', async () => {
    const failed = await explore('--steps', '3', '--min-screens', '50', '--min-active', '1').then(
      () => undefined,
      (e: { code: number; stdout: string }) => e,
    )
    expect(failed).toMatchObject({ code: 1 })
    expect(failed?.stdout).toMatch(/FAIL \d+ screens, want ≥ 50/)
    expect(failed?.stdout).toMatch(/FAIL 0 active test case\(s\), want ≥ 1/)
  }, 120_000)
})
