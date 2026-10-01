import { newId, walkTree, type protocol } from '@coral/shared'
import { FakeDriver, SAMPLE_APP, sampleApp } from '@coral/runner/testing'
import { describe, expect, it } from 'vitest'
import { DeviceCommands, LONG_PRESS_MS, SWIPE_MS } from './commands'
import { createAgentLogger, SecretValues } from './log'

type Command = protocol.Payload<'device.command'>['command']

function setup(opts: { busy?: boolean; driver?: FakeDriver } = {}) {
  const driver = opts.driver ?? new FakeDriver({ ...sampleApp(), showTyped: true })
  const sent: { type: string; payload: unknown; re?: string }[] = []
  const lines: string[] = []
  const secrets = new SecretValues()
  const log = createAgentLogger({
    level: 'debug',
    secrets,
    destination: { write: (line: string) => void lines.push(line) },
  })
  let acquired = 0
  let released = 0
  const commands = new DeviceCommands({
    connection: {
      send: (type, payload, re) => {
        sent.push({ type, payload, ...(re ? { re } : {}) })
        return newId()
      },
    },
    sessions: {
      acquire: () => {
        acquired += 1
        return Promise.resolve({
          driver,
          release: () => {
            released += 1
            return Promise.resolve()
          },
        })
      },
    },
    busy: () => opts.busy ?? false,
    secrets,
    log,
  })
  async function run(command: Command) {
    const messageId = newId()
    const commandId = newId()
    commands.handle(messageId, { command_id: commandId, udid: 'emulator-5554', command })
    await commands.idle()
    const reply = sent.find((m) => (m.payload as { command_id: string }).command_id === commandId)
    expect(reply?.type).toBe('device.command_result')
    expect(reply?.re).toBe(messageId)
    return reply?.payload as protocol.Payload<'device.command_result'>
  }
  return { driver, run, sent, lines, counts: () => ({ acquired, released }) }
}

/** Center of the element whose resource id ends with `idSuffix`, on the current screen. */
async function nodeCenter(driver: FakeDriver, idSuffix: string) {
  const node = [...walkTree(await driver.tree())].find((n) => n.platform_id.endsWith(idSuffix))
  if (!node) throw new Error(`${idSuffix} not on ${driver.current}`)
  return {
    x: Math.round(node.bounds.x + node.bounds.w / 2),
    y: Math.round(node.bounds.y + node.bounds.h / 2),
  }
}

describe('DeviceCommands (US3, FR-008)', () => {
  it('maps each command to the driver and answers with re = the command message', async () => {
    const { driver, run, counts } = setup()
    const menu = await nodeCenter(driver, 'id/menuIV')
    const result = await run({ kind: 'tap', ...menu })
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
    expect(driver.current).toBe('menu')
    await run({ kind: 'long_press', x: 10, y: 20 })
    await run({ kind: 'long_press', x: 10, y: 20, ms: 1500 })
    await run({ kind: 'swipe', from: { x: 500, y: 1800 }, to: { x: 500, y: 600 } })
    await run({ kind: 'back' })
    await run({ kind: 'hide_keyboard' })
    await run({ kind: 'home' })
    await run({ kind: 'restart_app', package: SAMPLE_APP })
    expect(driver.calls.slice(1).map((c) => ('ms' in c ? [c.kind, c.ms] : [c.kind]))).toEqual([
      ['longPress', LONG_PRESS_MS],
      ['longPress', 1500],
      ['swipe', SWIPE_MS],
      ['back'],
      ['hideKeyboard'],
      ['home'],
      ['stopApp'],
      ['launch'],
    ])
    expect(driver.calls.at(-1)).toEqual({ kind: 'launch', appId: SAMPLE_APP })
    // Every command borrows the shared device session and gives it back.
    expect(counts()).toEqual({ acquired: 8, released: 8 })
  })

  it('types into the focused field and never logs the text', async () => {
    const { driver, run, lines } = setup()
    driver.show('login')
    await run({ kind: 'tap', ...(await nodeCenter(driver, 'id/nameET')) })
    expect(await run({ kind: 'type', text: 'bod@example.com', redact: [] })).toMatchObject({
      ok: true,
    })
    await run({ kind: 'tap', ...(await nodeCenter(driver, 'id/passwordET')) })
    await run({ kind: 'type', text: '10203040', redact: ['10203040'], secret: 'TEST_PASSWORD' })
    expect([...driver.typed.values()]).toEqual(['bod@example.com', '10203040'])
    const log = lines.join('\n')
    expect(log).toContain('device command done')
    expect(log).not.toContain('bod@example.com')
    expect(log).not.toContain('10203040')
  })

  it('masks a secret in the error it sends back and in the log', async () => {
    const driver = new FakeDriver({ ...sampleApp() })
    driver.type = (text: string) => Promise.reject(new Error(`setText("${text}") failed`))
    const { run, lines } = setup({ driver })
    const result = await run({ kind: 'type', text: 's3cr3t-pass', redact: ['s3cr3t-pass'] })
    expect(result).toMatchObject({ ok: false, error: { code: 'command_failed' } })
    expect(result.error?.message).not.toContain('s3cr3t-pass')
    expect(lines.join('\n')).not.toContain('s3cr3t-pass')
  })

  it('refuses while a job runs on the device', async () => {
    const busy = setup({ busy: true })
    expect(await busy.run({ kind: 'back' })).toMatchObject({
      ok: false,
      error: { code: 'device_busy' },
    })
    expect(await busy.run({ kind: 'inspect', x: 1, y: 1, redact: [] })).toMatchObject({
      ok: false,
      error: { code: 'device_busy' },
    })
    const url = 'http://s3.test/x?X-Amz-Signature=s'
    expect(
      await busy.run({
        kind: 'observe',
        package: SAMPLE_APP,
        popups_yaml: '',
        upload: { screen: url, ai: url, tree: url },
        redact: [],
      }),
    ).toMatchObject({ ok: false, error: { code: 'device_busy' } })
    expect(busy.driver.calls).toEqual([])
  })

  it('runs the commands of one device in order', async () => {
    const { driver, run } = setup()
    const menu = await nodeCenter(driver, 'id/menuIV')
    const [a, b] = [run({ kind: 'tap', ...menu }), run({ kind: 'back' })]
    await Promise.all([a, b])
    expect(driver.calls.map((c) => c.kind)).toEqual(['tap', 'back'])
    expect(driver.current).toBe('catalog')
  })
})
