import { DEFAULT_POPUPS_YAML, MASK, newId, protocol, walkTree } from '@coral/shared'
import { FakeClock, FakeDriver, SAMPLE_APP, el, sampleApp, windows } from '@coral/runner/testing'
import { crashExcerpt, imageInfo } from '@coral/runner'
import { describe, expect, it } from 'vitest'
import { DeviceCommands } from './commands'
import { SecretValues } from './log'

type Command = protocol.Payload<'device.command'>['command']

const UPLOAD = {
  screen: 'https://s3.test/explorations/e/4/screen.jpg',
  ai: 'https://s3.test/explorations/e/4/ai.jpg',
  tree: 'https://s3.test/explorations/e/4/tree.json',
}
const SECRET = 'bod@example.com'

/** The system's "keeps stopping" dialog of the app under test, over its window. */
const crashDialog = windows(
  SAMPLE_APP,
  el({ bounds: [0, 0, 1080, 2400] }),
  el({
    package_or_bundle: 'android',
    bounds: [80, 900, 920, 600],
    children: [
      el({
        platform_id: 'android:id/alertTitle',
        text: 'My Demo App keeps stopping',
        bounds: [120, 940, 840, 80],
      }),
      el({
        platform_id: 'android:id/aerr_close',
        text: 'Close app',
        bounds: [120, 1300, 840, 120],
        clickable: true,
      }),
    ],
  }),
)

function setup(screen = 'catalog', logs = '') {
  const app = sampleApp()
  const driver = new FakeDriver({
    ...app,
    screens: { ...app.screens, crash: { frames: [crashDialog] } },
    initial: screen,
    renderScreens: true,
    showTyped: true,
    logs,
  })
  driver.current = screen
  driver.appRunning = true
  const puts = new Map<string, { body: Uint8Array | string; type: string }>()
  const sent: protocol.Payload<'device.command_result'>[] = []
  const commands = new DeviceCommands({
    connection: {
      send: (_type, payload) => {
        sent.push(payload as protocol.Payload<'device.command_result'>)
        return newId()
      },
    },
    sessions: { acquire: () => Promise.resolve({ driver, release: () => Promise.resolve() }) },
    secrets: new SecretValues(),
    recorder: { clock: new FakeClock() },
    fetch: (url, init) => {
      const headers = new Headers(init?.headers)
      const href = url instanceof Request ? url.url : url.toString()
      puts.set(href, {
        body: init?.body as Uint8Array | string,
        type: headers.get('content-type') ?? '',
      })
      return Promise.resolve(new Response(null, { status: href.includes('fail') ? 500 : 200 }))
    },
  })
  async function observe(over: Partial<Extract<Command, { kind: 'observe' }>> = {}) {
    const commandId = newId()
    commands.handle(newId(), {
      command_id: commandId,
      udid: 'emulator-5554',
      command: {
        kind: 'observe',
        package: SAMPLE_APP,
        popups_yaml: DEFAULT_POPUPS_YAML,
        upload: UPLOAD,
        redact: [SECRET],
        ...over,
      },
    })
    await commands.idle()
    const reply = sent.find((m) => m.command_id === commandId)
    if (!reply) throw new Error('no reply')
    return reply
  }
  return { driver, puts, observe }
}

describe('observe (T018, contracts/agent-ws-phase3.md)', () => {
  it('uploads screen.jpg, a 1024 px ai.jpg and the tree, and returns the tree inline', async () => {
    const { observe, puts } = setup()
    const reply = await observe()
    expect(reply.ok).toBe(true)
    const result = protocol.commandResultSchemas.observe.parse(reply.result)
    expect(result).toMatchObject({
      screen_width: 1080,
      screen_height: 2400,
      package: SAMPLE_APP,
      activity: '.catalog',
      app_running: true,
      crash: null,
      popups_handled: [],
    })
    expect([...puts.keys()].sort()).toEqual(Object.values(UPLOAD).sort())
    const ai = puts.get(UPLOAD.ai)?.body as Uint8Array
    expect(puts.get(UPLOAD.ai)?.type).toBe('image/jpeg')
    expect(imageInfo(ai)).toMatchObject({ width: 461, height: 1024 })
    expect(JSON.parse(puts.get(UPLOAD.tree)?.body as string)).toEqual(result.tree)
    expect([...walkTree(result.tree)].some((n) => n.platform_id.endsWith('id/menuIV'))).toBe(true)
  })

  it('masks secret values in the tree it returns and uploads', async () => {
    const { driver, observe, puts } = setup('login')
    const name = [...walkTree(await driver.tree())].find((n) => n.platform_id.endsWith('id/nameET'))
    await driver.tapAt({ x: (name?.bounds.x ?? 0) + 10, y: (name?.bounds.y ?? 0) + 10 })
    await driver.type(SECRET)
    const reply = await observe()
    const text = JSON.stringify(reply.result)
    expect(text).not.toContain(SECRET)
    expect(text).toContain(MASK)
    expect(puts.get(UPLOAD.tree)?.body).not.toContain(SECRET)
  })

  it('lets the project rules handle a permission dialog first', async () => {
    const { driver, observe } = setup('qr_permission')
    const result = protocol.commandResultSchemas.observe.parse((await observe()).result)
    expect(result.popups_handled).toEqual(['android_permission'])
    expect(driver.current).toBe('qr')
    expect(result.activity).toBe('.qr')
  })

  it('reports a crash dialog of the app with its log, without dismissing it', async () => {
    const log = [
      '10-01 10:00:00.000  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main',
      `10-01 10:00:00.000  4242  4242 E AndroidRuntime: Process: ${SAMPLE_APP}, PID: 4242`,
      `10-01 10:00:00.001  4242  4242 E AndroidRuntime: java.lang.IllegalStateException: user ${SECRET}`,
    ].join('\n')
    const { driver, observe } = setup('crash', log)
    const result = protocol.commandResultSchemas.observe.parse((await observe()).result)
    expect(result.crash?.kind).toBe('crashed')
    expect(result.crash?.log_excerpt).toContain('FATAL EXCEPTION')
    expect(result.crash?.log_excerpt).not.toContain(SECRET)
    expect(driver.current).toBe('crash')
    expect(driver.calls.some((c) => c.kind === 'tap')).toBe(false)
  })

  it('tells when the app died, with the crash found in the log', async () => {
    const log = `E AndroidRuntime: FATAL EXCEPTION: main\nE AndroidRuntime: Process: ${SAMPLE_APP}, PID: 1\n`
    const gone = setup('catalog', log)
    gone.driver.appRunning = false
    const result = protocol.commandResultSchemas.observe.parse((await gone.observe()).result)
    expect(result).toMatchObject({ app_running: false, crash: { kind: 'crashed' } })
    const left = setup('catalog', '')
    left.driver.appRunning = false
    expect((await left.observe()).result).toMatchObject({ app_running: false, crash: null })
  })

  it('answers upload_failed when a presigned PUT fails and invalid_popups for broken rules', async () => {
    const { observe } = setup()
    expect(
      await observe({ upload: { ...UPLOAD, ai: 'https://s3.test/fail/ai.jpg' } }),
    ).toMatchObject({
      ok: false,
      error: { code: 'upload_failed' },
    })
    expect(await observe({ popups_yaml: 'schema: nope' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_popups' },
    })
  })
})

describe('crashExcerpt', () => {
  const redactor = { text: (t: string) => t.replaceAll(SECRET, MASK), value: <T>(v: T) => v }

  it('starts at the crash or ANR of the app and keeps 4 KB', () => {
    const other =
      'E AndroidRuntime: FATAL EXCEPTION: main\nE AndroidRuntime: Process: com.other, PID: 9'
    expect(crashExcerpt(other, SAMPLE_APP, redactor)).toBeUndefined()
    const anr = `I ActivityManager: ANR in ${SAMPLE_APP} (${SAMPLE_APP}/.MainActivity)\n${'x'.repeat(5000)}`
    const found = crashExcerpt(anr, SAMPLE_APP, redactor)
    expect(found?.kind).toBe('not_responding')
    expect(found?.excerpt.length).toBe(protocol.MAX_LOG_EXCERPT)
  })
})
