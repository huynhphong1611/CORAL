import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MASK, parseYaml, testCaseSchema } from '@coral/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LocalDirSink } from '../sinks/local-dir'
import { FakeClock } from '../testing/fake-clock'
import { FakeDriver, el, windows } from '../testing/fake-driver'
import { runTestCase, type RunEvent } from './run-testcase'

const APP = 'com.example.app'
const PASSWORD = 'hunter2-secret'
/** Handed to the run but not referenced by the test case: still masked (D19). */
const TOKEN = 'tok-9f8e7d6c'

const testCase = testCaseSchema.parse(
  parseYaml(`schema: coral/testcase@1
id: login
intent: x
platforms: [android]
steps:
  - id: s1
    action: launch
    expect: { visible_text: 'Login' }
  - id: s2
    action: type
    target: [{ android_id: 'id/password' }]
    value: \${secret:PASSWORD}
  - id: s3
    action: tap
    target: [{ text: 'Login' }]
    expect: { visible_text: 'Welcome' }
  - id: s4
    action: assert
    expect: { visible_text: 'Goodbye \${secret:PASSWORD}', timeout_ms: 500 }
`).value,
)

// The app echoes both values on screen and in logcat, as a leaky app would.
const login = windows(
  APP,
  el({
    bounds: [0, 0, 1080, 2400],
    children: [
      el({
        platform_id: `${APP}:id/password`,
        class: 'android.widget.EditText',
        text: PASSWORD,
        clickable: true,
        bounds: [100, 100, 800, 120],
      }),
      el({ text: 'Login', clickable: true, bounds: [100, 300, 800, 120] }),
    ],
  }),
)
const home = windows(
  APP,
  el({
    bounds: [0, 0, 1080, 2400],
    children: [
      el({ text: `Welcome, ${PASSWORD}`, bounds: [0, 100, 1080, 100] }),
      el({ desc: `session ${TOKEN}`, bounds: [0, 300, 1080, 100] }),
    ],
  }),
)

let out = ''
beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'coral-redaction-'))
})
afterAll(() => rm(out, { recursive: true, force: true }))

async function filesUnder(dir: string): Promise<Record<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const files: Record<string, string> = {}
  for (const entry of entries.filter((e) => e.isFile())) {
    const path = join(entry.parentPath, entry.name)
    files[path.slice(dir.length + 1)] = await readFile(path, 'utf8')
  }
  return files
}

const count = (text: string, value: string) => text.split(value).length - 1

describe('secrets in run outputs (SC-008, D19)', () => {
  it('masks every secret in events, result.json, tree.json and device.log', async () => {
    const events: RunEvent[] = []
    const driver = new FakeDriver({
      screens: { login: { frames: [login], taps: { Login: 'home' } }, home: { frames: [home] } },
      start: 'login',
      logs: `I/App: signing in with ${PASSWORD}\nD/Net: Authorization: Bearer ${TOKEN}\n`,
    })
    const result = await runTestCase({
      driver,
      testCase,
      appId: APP,
      secrets: { PASSWORD, TOKEN },
      sink: new LocalDirSink(out),
      clock: new FakeClock(),
      onEvent: (event) => events.push(event),
    })

    // The secret really reached the device, and the run failed where the log is kept.
    expect(driver.calls).toContainEqual({ kind: 'type', text: PASSWORD })
    expect(result).toMatchObject({ status: 'failed', failure_code: 'EXPECT_FAILED' })

    const files = await filesUnder(out)
    expect(Object.keys(files).sort()).toEqual(
      expect.arrayContaining([
        'login/result.json',
        'login/2-s3/tree.json',
        'login/3-s4/tree.json',
        'login/3-s4/device.log',
      ]),
    )
    const outputs = { ...files, events: JSON.stringify(events), result: JSON.stringify(result) }
    for (const [name, text] of Object.entries(outputs)) {
      expect({ name, password: count(text, PASSWORD), token: count(text, TOKEN) }).toEqual({
        name,
        password: 0,
        token: 0,
      })
    }
    // Masked, not dropped: the evidence is still there.
    expect(files['login/3-s4/device.log']).toBe(
      `I/App: signing in with ${MASK}\nD/Net: Authorization: Bearer ${MASK}\n`,
    )
    expect(files['login/2-s3/tree.json']).toContain(`Welcome, ${MASK}`)
    expect(files['login/2-s3/tree.json']).toContain(`session ${MASK}`)
    expect(result.message).toBe(`text "Goodbye ${MASK}" is not visible`)
  })
})
