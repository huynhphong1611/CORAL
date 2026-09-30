import {
  DEFAULT_POPUPS_YAML,
  newId,
  protocol,
  walkTree,
  type ElementNode,
  type Step,
} from '@coral/shared'
import { FakeClock, FakeDriver, SAMPLE_APP, sampleApp } from '@coral/runner/testing'
import { describe, expect, it } from 'vitest'
import { DeviceCommands } from './commands'
import { SecretValues } from './log'

type Command = protocol.Payload<'device.command'>['command']
type RecordCommand = Extract<Command, { kind: 'record' }>

const UPLOAD = {
  screen: 'https://s3.test/rec/1/screen.jpg',
  tree: 'https://s3.test/rec/1/tree.json',
  element: 'https://s3.test/rec/1/element.png',
}
const IMAGE = 'snap/recording/recorded/element.png'
/** The tenant's secret values, as the server sends them with every recorder command. */
const REDACT = ['bod@example.com', 's3cret-value']

function setup(screen = 'catalog') {
  const driver = new FakeDriver({
    ...sampleApp(),
    initial: screen,
    renderScreens: true,
    showTyped: true,
  })
  driver.current = screen
  const puts = new Map<string, { body: Uint8Array | string; type: string }>()
  const sent: { payload: protocol.Payload<'device.command_result'> }[] = []
  const secrets = new SecretValues()
  const commands = new DeviceCommands({
    connection: {
      send: (_type, payload) => {
        sent.push({ payload: payload as protocol.Payload<'device.command_result'> })
        return newId()
      },
    },
    sessions: { acquire: () => Promise.resolve({ driver, release: () => Promise.resolve() }) },
    secrets,
    recorder: { clock: new FakeClock() },
    fetch: (url, init) => {
      const headers = new Headers(init?.headers)
      puts.set(url instanceof Request ? url.url : url.toString(), {
        body: init?.body as Uint8Array | string,
        type: headers.get('content-type') ?? '',
      })
      return Promise.resolve(new Response(null, { status: 200 }))
    },
  })
  async function run(command: Command) {
    const commandId = newId()
    commands.handle(newId(), { command_id: commandId, udid: 'emulator-5554', command })
    await commands.idle()
    const reply = sent.find((m) => m.payload.command_id === commandId)?.payload
    if (!reply) throw new Error('no reply')
    return reply
  }
  async function rec(action: RecordCommand['action']) {
    puts.clear()
    const reply = await run({
      kind: 'record',
      action,
      package: SAMPLE_APP,
      popups_yaml: DEFAULT_POPUPS_YAML,
      upload: UPLOAD,
      redact: REDACT,
    })
    if (!reply.ok) return { reply }
    const result = protocol.commandResultSchemas.record.parse(reply.result)
    return { reply, result, step: result.step }
  }
  const at = async (idSuffix: string) => {
    const node = [...walkTree(await driver.tree())].find((n) => n.platform_id.endsWith(idSuffix))
    if (!node) throw new Error(`${idSuffix} not on ${driver.current}`)
    return {
      x: Math.round(node.bounds.x + node.bounds.w / 3),
      y: Math.round(node.bounds.y + node.bounds.h / 3),
    }
  }
  return { driver, run, rec, puts, at, secrets }
}

const targetOf = (step: Step | undefined) => (step && 'target' in step ? step.target : undefined)

describe('Recorder on the agent (T040, research R8–R9)', () => {
  it('prepare: installs, clears, launches and snapshots the first screen', async () => {
    const { driver, run, puts } = setup('login')
    const reply = await run({
      kind: 'prepare',
      package: SAMPLE_APP,
      app_state: 'fresh',
      popups_yaml: DEFAULT_POPUPS_YAML,
      upload: { screen: UPLOAD.screen, tree: UPLOAD.tree },
      redact: REDACT,
    })
    expect(reply).toMatchObject({ ok: true, result: { screen_width: 1080, screen_height: 2400 } })
    expect(driver.calls.map((c) => c.kind)).toEqual(
      expect.arrayContaining(['resetApp', 'launch', 'screenshot']),
    )
    expect(driver.current).toBe('catalog')
    expect(puts.get(UPLOAD.screen)?.type).toBe('image/jpeg')
    expect(JSON.parse(String(puts.get(UPLOAD.tree)?.body))).toBeInstanceOf(Array)
  })

  it('tap: the element under the click, its chain with the image, the snapshot, suggestions', async () => {
    const { driver, rec, puts, at } = setup()
    const { result, step } = await rec({ kind: 'tap', ...(await at('id/menuIV')) })
    expect(step).toEqual({
      id: 'recorded',
      action: 'tap',
      target: [
        { android_id: 'id/menuIV' },
        { desc: 'View menu' },
        { image: { path: IMAGE, screen_width: 1080 } },
      ],
    })
    // The tap went to the centre of the element, as a replay does.
    expect(driver.calls.find((c) => c.kind === 'tap')).toMatchObject({ point: { x: 79, y: 165 } })
    expect(driver.current).toBe('menu')
    expect(result?.suggestions).toEqual([
      { visible_text: 'Catalog' },
      { visible: { android_id: 'id/menuRV' } },
      { visible_text: 'WebView' },
    ])
    expect(result?.warnings).toEqual(['no_expect_after_tap'])
    expect([...puts.keys()].sort()).toEqual([UPLOAD.element, UPLOAD.screen, UPLOAD.tree].sort())
    expect(puts.get(UPLOAD.element)?.type).toBe('image/png')
    expect(puts.get(UPLOAD.screen)?.type).toBe('image/jpeg')
  })

  it('long_press and swipe keep their length; back and hide_keyboard are steps too', async () => {
    const { rec, at } = setup()
    const press = await rec({ kind: 'long_press', ...(await at('id/cartIV')), ms: 1200 })
    expect(press.step).toMatchObject({ action: 'long_press', ms: 1200 })
    expect(targetOf(press.step)?.[0]).toEqual({ android_id: 'id/cartIV' })
    const swipe = await rec({ kind: 'swipe', from: { x: 540, y: 1800 }, to: { x: 540, y: 600 } })
    expect(swipe.step).toEqual({
      id: 'recorded',
      action: 'swipe',
      from: [0.5, 0.75],
      to: [0.5, 0.25],
    })
    expect((await rec({ kind: 'back' })).step).toEqual({ id: 'recorded', action: 'back' })
    expect((await rec({ kind: 'hide_keyboard' })).step).toEqual({
      id: 'recorded',
      action: 'hide_keyboard',
    })
  })

  it('type: into the focused field; a password only by secret, never as text', async () => {
    const { driver, rec, at, puts, secrets } = setup('login')
    await rec({ kind: 'tap', ...(await at('id/nameET')) })
    // The login screen shows the demo user: a secret value of the tenant, masked in tree.json.
    expect(String(puts.get(UPLOAD.tree)?.body)).not.toContain('bod@example.com')
    // The login screen shows the demo user: a secret value of the tenant, masked in tree.json.
    expect(String(puts.get(UPLOAD.tree)?.body)).not.toContain('bod@example.com')
    const user = await rec({ kind: 'type', text: 'bod@example.com', redact: [] })
    expect(user.step).toEqual({
      id: 'recorded',
      action: 'type',
      target: [
        { android_id: 'id/nameET' },
        { rel: { below: { text: 'Username' }, class: 'EditText' } },
      ],
      value: 'bod@example.com',
    })
    expect(user.result?.target_password).toBe(false)

    await rec({ kind: 'tap', ...(await at('id/passwordET')) })
    const typedBefore = driver.calls.filter((c) => c.kind === 'type').length
    const plain = await rec({ kind: 'type', text: 'hunter22', redact: [] })
    expect(plain.reply).toMatchObject({ ok: false, error: { code: 'secret_required' } })
    expect(driver.calls.filter((c) => c.kind === 'type')).toHaveLength(typedBefore)

    const password = await rec({
      kind: 'type',
      text: 's3cret-value',
      redact: ['s3cret-value'],
      secret: 'TEST_PASSWORD',
    })
    expect(password.step).toMatchObject({ action: 'type', value: '${secret:TEST_PASSWORD}' })
    expect(password.result?.target_password).toBe(true)
    expect(JSON.stringify(password)).not.toContain('s3cret-value')
    // The next snapshot's tree has the typed secret masked.
    await rec({ kind: 'hide_keyboard' })
    const tree = String(puts.get(UPLOAD.tree)?.body)
    expect(tree).not.toContain('s3cret-value')
    expect(tree).toContain('***')
    expect(secrets.redactor.text('s3cret-value')).toBe('***')
  })

  it('a tap a popup rule handles is done but not recorded (FR-015)', async () => {
    const { driver, rec, puts } = setup('qr_permission')
    const tree: ElementNode[] = await driver.tree()
    const allow = [...walkTree(tree)].find((n) => n.text === 'While using the app')
    if (!allow) throw new Error('no allow button')
    const { reply, result } = await rec({
      kind: 'tap',
      x: allow.bounds.x + 5,
      y: allow.bounds.y + 5,
    })
    expect(reply.ok).toBe(true)
    expect(result).toMatchObject({ popup_rule: 'android_permission', suggestions: [] })
    expect(result?.step).toBeUndefined()
    expect(driver.current).toBe('qr')
    expect(puts.size).toBe(0)
  })

  it('home is no test step; inspect reads an element without touching it', async () => {
    const { driver, run, rec } = setup()
    expect((await rec({ kind: 'home' })).reply).toMatchObject({
      ok: false,
      error: { code: 'not_recordable' },
    })
    const calls = driver.calls.length
    const reply = await run({ kind: 'inspect', x: 100, y: 300, redact: REDACT })
    expect(driver.calls.slice(calls).every((c) => c.kind !== 'tap')).toBe(true)
    const inspected = protocol.commandResultSchemas.inspect.parse(reply.result)
    expect(inspected.text).toBe('Products')
    expect(inspected.element.children).toEqual([])
    // The package of the last recording writes the app's ids short.
    expect(inspected.locators[0]).toEqual({ android_id: 'id/productTV' })
    expect(inspected.locators).toContainEqual({ text: 'Products' })
  })
})
