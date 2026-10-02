import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MASK, createRedactor, protocol } from '@coral/shared'
import { FakeClock, FakeDriver, el, windows } from '@coral/runner/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DeviceSessions } from './device-sessions'
import { JobManager } from './jobs'
import { SecretValues, createAgentLogger, redactLogArg } from './log'

const APP = 'com.example.app'
const RUN = '0192f000-0000-7000-8000-000000000001'
const ITEM = '0192f000-0000-7000-8000-000000000011'
const APK = Buffer.from('fake apk bytes')
const USER = 'bob-secret@example.com'
/** Sent with the job but not used by its test case: still masked. */
const API_KEY = 'k3y-unused-123'

const TEST_CASE = `schema: coral/testcase@1
id: login
intent: x
platforms: [android]
variables:
  user: \${secret:TEST_USER}
steps:
  - id: s1
    action: type
    target: [{ android_id: 'id/user' }]
    value: \${var:user}
  - id: s2
    action: tap
    target: [{ text: 'Login' }]
    expect: { visible_text: 'Goodbye \${var:user}', timeout_ms: 500 }
`

// A leaky app: the user name on screen, both secrets in logcat.
const screen = windows(
  APP,
  el({
    bounds: [0, 0, 1080, 2400],
    children: [
      el({
        platform_id: `${APP}:id/user`,
        class: 'android.widget.EditText',
        text: USER,
        clickable: true,
        bounds: [100, 100, 800, 120],
      }),
      el({ text: 'Login', clickable: true, bounds: [100, 300, 800, 120] }),
      el({ desc: `key ${API_KEY}`, bounds: [100, 500, 800, 120] }),
    ],
  }),
)

let cacheDir = ''
beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'coral-agent-redaction-'))
})
afterAll(() => rm(cacheDir, { recursive: true, force: true }))

const count = (text: string, value: string) => text.split(value).length - 1

describe('redacting logger', () => {
  const secrets = new SecretValues()
  secrets.add([USER])

  it('masks strings, nested fields and errors, and keeps errors printable', () => {
    const error = Object.assign(new Error(`login failed for ${USER}`), { code: `E_${USER}` })
    error.cause = new Error(`cause ${USER}`)
    const masked = redactLogArg(
      { user: USER, nested: [{ note: `hi ${USER}` }], err: error, at: new Date(0) },
      secrets.redactor,
    ) as { user: string; nested: { note: string }[]; err: Error & { code: string }; at: Date }
    expect(masked.user).toBe(MASK)
    expect(masked.nested[0]?.note).toBe(`hi ${MASK}`)
    expect(masked.err).toBeInstanceOf(Error)
    expect(masked.err.message).toBe(`login failed for ${MASK}`)
    expect(masked.err.code).toBe(`E_${MASK}`)
    expect(masked.err.stack).not.toContain(USER)
    expect((masked.err.cause as Error).message).toBe(`cause ${MASK}`)
    expect(masked.at).toEqual(new Date(0))
    expect(error.message).toContain(USER) // the original is untouched
  })

  it('survives circular values', () => {
    const loop: Record<string, unknown> = { user: USER }
    loop.self = loop
    expect(redactLogArg(loop, secrets.redactor)).toEqual({ user: MASK, self: '[Circular]' })
  })

  it('masks every argument of a log call, including values added after it was created', () => {
    const lines: string[] = []
    const later = new SecretValues()
    const log = createAgentLogger({
      level: 'debug',
      secrets: later,
      destination: { write: (line: string) => void lines.push(line) },
    })
    later.add([USER])
    log.info({ user: USER }, 'signed in as %s (%s)', USER, `again ${USER}`)
    log.child({ run: RUN }).warn({ err: new Error(`bad ${USER}`) }, 'child logger')
    const text = lines.join('')
    expect(count(text, USER)).toBe(0)
    expect(text).toContain(`signed in as ${MASK} (again ${MASK})`)
    expect(text).toContain(`"message":"bad ${MASK}"`)
  })
})

describe('secrets in agent outputs (SC-008)', () => {
  it('leaks no secret in messages, uploads or logs of a failing job', async () => {
    const sent: string[] = []
    const uploads: string[] = []
    const lines: string[] = []
    const secrets = new SecretValues()
    const log = createAgentLogger({
      level: 'trace',
      secrets,
      destination: { write: (line: string) => void lines.push(line) },
    })
    const connection = {
      send(type: protocol.MessageType, payload: unknown) {
        sent.push(JSON.stringify({ type, payload }))
        return 'id'
      },
      request(_type: protocol.MessageType, payload: unknown) {
        const p = payload as protocol.Payload<'artifact.request_upload'>
        return Promise.resolve(
          protocol.envelope('artifact.upload_url', {
            uploads: p.files.map((f) => ({
              name: f.name,
              url: `http://s3.test/put/${p.step_index}/${f.name}`,
              key: `t/runs/${p.run_id}/${p.run_item_id}/${p.step_index}-${p.step_id}/${f.name}`,
              expires_at: new Date().toISOString(),
            })),
          }) as protocol.Message,
        )
      },
    }
    const fakeFetch = ((_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        uploads.push(Buffer.from(init.body as Uint8Array).toString('utf8'))
        return Promise.resolve(new Response(null, { status: 200 }))
      }
      return Promise.resolve(new Response(APK, { status: 200 }))
    }) as unknown as typeof fetch
    let driver: FakeDriver | undefined
    const manager = new JobManager({
      connection: connection as never,
      cacheDir,
      fetch: fakeFetch,
      clock: new FakeClock(),
      log,
      secrets,
      sessions: new DeviceSessions({
        idleMs: 0,
        log,
        createDriver: () => {
          driver = new FakeDriver({
            screens: { login: { frames: [screen] } },
            start: 'login',
            logs: `I/App: user=${USER} key=${API_KEY}\n`,
          })
          return Promise.resolve(
            Object.assign(driver, {
              open: () => Promise.resolve(),
              // Cleanup fails with a message that quotes a secret: the log line must mask it.
              close: () => Promise.reject(new Error(`cannot reset settings for ${USER}`)),
            }),
          )
        },
      }),
    })

    manager.handle(
      protocol.envelope('job.assign', {
        run_id: RUN,
        device_udid: 'emulator-5554',
        build: {
          build_id: RUN,
          package: APP,
          download_url: 'http://s3.test/build.apk',
          sha256: createHash('sha256').update(APK).digest('hex'),
        },
        items: [
          {
            run_item_id: ITEM,
            test_case_id: RUN,
            commit: 'a1b2c3d',
            yaml: TEST_CASE,
            assets: [],
            screens: {},
          },
        ],
        popups_yaml: 'schema: coral/popups@1\n',
        secrets: { TEST_USER: USER, API_KEY },
        limits: { run_timeout_ms: 1_800_000, stable_timeout_ms: 3000 },
      }),
    )
    await manager.drain()

    // The secret was typed on the device and the job failed with evidence.
    expect(driver?.calls).toContainEqual({ kind: 'type', text: USER })
    expect(sent.at(-1)).toContain('"status":"failed"')
    expect(uploads.some((u) => u.includes(`key=${MASK}`))).toBe(true)
    expect(lines.join('')).toContain(`cannot reset settings for ${MASK}`)

    const outputs = { messages: sent.join('\n'), uploads: uploads.join('\n'), logs: lines.join('') }
    for (const [name, text] of Object.entries(outputs)) {
      expect({ name, user: count(text, USER), key: count(text, API_KEY) }).toEqual({
        name,
        user: 0,
        key: 0,
      })
    }
    // Sanity check of the scan itself.
    expect(createRedactor([USER]).text(USER)).toBe(MASK)
  })
})
