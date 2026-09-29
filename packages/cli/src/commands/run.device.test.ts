import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultDeps } from '../deps'
import { createProgram } from '../program'

// 🔌 T041 / SC-005: needs an Android emulator with My Demo App (or CORAL_TEST_APK to install it).
const APP = process.env.CORAL_TEST_APP ?? 'com.saucelabs.mydemoapp.android'
const testCase = new URL('../../../../fixtures/testcases/mydemo-login.yaml', import.meta.url)
  .pathname

// On CI (CORAL_DEVICE_OUT, scripts/ci-device.sh) the run's steps are kept next to the other
// device results, so a failure comes with its screenshots, tree and device log.
const keep = process.env.CORAL_DEVICE_OUT
let out = ''
beforeAll(async () => {
  out = keep ? join(keep, 'coral-run-test') : await mkdtemp(join(tmpdir(), 'coral-device-run-'))
})
afterAll(() => (keep ? undefined : rm(out, { recursive: true, force: true })))

describe('coral run on a real device', () => {
  it('passes mydemo-login in under 60 s', async () => {
    const env = {
      ...process.env,
      // Public demo account of the sample app (research R15); override in .env if it changes.
      CORAL_SECRET_TEST_USER: process.env.CORAL_SECRET_TEST_USER ?? 'bod@example.com',
      CORAL_SECRET_TEST_PASSWORD: process.env.CORAL_SECRET_TEST_PASSWORD ?? '10203040',
    }
    let stdout = ''
    let stderr = ''
    let code: number | undefined
    const args = ['run', testCase, '--app', APP, '--out', out]
    if (process.env.CORAL_TEST_UDID) args.push('--device', process.env.CORAL_TEST_UDID)
    if (process.env.CORAL_TEST_APK) args.push('--apk', process.env.CORAL_TEST_APK)
    const started = Date.now()
    await createProgram(
      { out: (t) => (stdout += t), err: (t) => (stderr += t), setExitCode: (c) => (code = c) },
      () => defaultDeps(env),
    ).parseAsync(args, { from: 'user' })
    const seconds = (Date.now() - started) / 1000
    console.log(stdout, stderr)
    expect(code).toBe(0)
    expect(seconds).toBeLessThan(60)
    const result = JSON.parse(await readFile(join(out, 'mydemo-login', 'result.json'), 'utf8')) as {
      status: string
      steps: { step_id: string; degraded: boolean }[]
    }
    expect(result.status).toBe('passed')
    // Degraded steps mean an android_id in the fixture needs updating (research R15).
    expect(result.steps.filter((s) => s.degraded).map((s) => s.step_id)).toEqual([])
  }, 120_000)
})
