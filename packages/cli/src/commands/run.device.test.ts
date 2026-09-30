import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { walkTree } from '@coral/shared'
import { imageInfo, openCvMatcher, realClock, snapshotFromPng, waitForStable } from '@coral/runner'
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The menu button cut from the catalog the way the recorder saves a reference (T040): tree
 * stable, then a screenshot. The screenshots a run keeps are no good for this: on a slow emulator
 * the one after mydemo-login's s1 still showed the splash screen while the tree already had the
 * catalog, and the cut was blank. So the cut must be found again, in place, on the next
 * screenshot, which a blank or half-drawn one never is.
 */
async function cutMenu(timeoutMs = 20_000): Promise<{ element: Uint8Array; width: number }> {
  const deps = defaultDeps(process.env)
  const udid =
    process.env.CORAL_TEST_UDID ??
    (await deps.listDevices()).find((d) => d.state === 'device')?.udid
  if (!udid) throw new Error('no device')
  const driver = await deps.createDriver({ udid, appId: APP })
  await driver.open()
  try {
    const matcher = openCvMatcher()
    const deadline = Date.now() + timeoutMs
    let seen = 'nothing yet'
    for (;;) {
      const { tree } = await waitForStable(driver, realClock)
      const menu = [...walkTree(tree)].find(
        (n) => n.visible && n.platform_id.endsWith(':id/menuIV'),
      )
      const screen = await driver.screenshot()
      const info = imageInfo(screen)
      const element =
        menu && info
          ? snapshotFromPng(screen, { width: info.width, height: info.height }, menu.bounds).element
          : undefined
      if (menu && info && element) {
        const match = await matcher.find(await driver.screenshot(), element, { threshold: 0.95 })
        const off = match
          ? Math.max(
              Math.abs(match.bounds.x - menu.bounds.x),
              Math.abs(match.bounds.y - menu.bounds.y),
            )
          : Infinity
        if (off <= 2) return { element, width: info.width }
        seen = match ? `found ${off} px away` : 'cut not found again'
      } else {
        seen = menu ? 'no cut' : 'no menu button in the tree'
      }
      if (Date.now() > deadline) throw new Error(`menu button: ${seen} after ${timeoutMs} ms`)
      await sleep(500)
    }
  } finally {
    await driver.close()
  }
}

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

  it('taps the menu by its picture when its id changed: degraded, passed (US6 T053)', async () => {
    // The run above ends on the catalog, with the menu button at the top left.
    const { element, width } = await cutMenu()

    const project = await mkdtemp(join(tmpdir(), 'coral-device-image-'))
    const reference = 'snap/mydemo-image/s2/element.png'
    await mkdir(join(project, 'testcases'))
    await mkdir(join(project, 'snap', 'mydemo-image', 's2'), { recursive: true })
    await writeFile(join(project, reference), element)
    const file = join(project, 'testcases', 'mydemo-image.yaml')
    await writeFile(
      file,
      `schema: coral/testcase@1
id: mydemo-image
intent: 'Mở menu bằng ảnh khi id của nút đã đổi'
platforms: [android]
preconditions:
  app_state: fresh
steps:
  - id: s1
    action: launch
    expect: { visible_text: 'Products', timeout_ms: 15000 }
  - id: s2
    action: tap
    target:
      - android_id: 'id/menuButtonRenamed'
      - image: { path: '${reference}', screen_width: ${width} }
    expect: { visible_text: 'Log In' }
`,
    )
    let stdout = ''
    let code: number | undefined
    const args = ['run', file, '--app', APP, '--out', out]
    if (process.env.CORAL_TEST_UDID) args.push('--device', process.env.CORAL_TEST_UDID)
    await createProgram(
      { out: (t) => (stdout += t), err: (t) => (stdout += t), setExitCode: (c) => (code = c) },
      () => defaultDeps(process.env),
    ).parseAsync(args, { from: 'user' })
    console.log(stdout)
    await rm(project, { recursive: true, force: true })
    expect(code).toBe(0)
    const result = JSON.parse(await readFile(join(out, 'mydemo-image', 'result.json'), 'utf8')) as {
      status: string
      steps: { step_id: string; degraded: boolean; locator_used_index: number | null }[]
    }
    expect(result.status).toBe('passed')
    expect(result.steps[1]).toMatchObject({ step_id: 's2', degraded: true, locator_used_index: 1 })
  }, 120_000)
})
