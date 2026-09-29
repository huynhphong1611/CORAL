import { newId, protocol } from '@coral/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UiSocket, uiSocketUrl, type SocketLike } from './ws'

/** In-memory WebSocket: the test plays the server. */
class FakeSocket implements SocketLike {
  static all: FakeSocket[] = []
  readyState = 0
  binaryType = 'blob'
  sent: { type: string; id: string; payload: unknown }[] = []
  private listeners: Record<string, ((event: never) => void)[]> = {}
  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  addEventListener(type: string, listener: (event: never) => void) {
    ;(this.listeners[type] ??= []).push(listener)
  }
  private emit(type: string, event: unknown) {
    for (const listener of this.listeners[type] ?? []) listener(event as never)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as { type: string; id: string; payload: unknown })
  }
  close() {
    this.readyState = 3
    this.emit('close', {})
  }
  // --- server side
  open() {
    this.readyState = 1
    this.emit('open', {})
  }
  reply(type: protocol.UiMessageType, payload: unknown, re?: string) {
    this.emit('message', { data: JSON.stringify(protocol.envelope(type, payload, re)) })
  }
  ready() {
    const auth = this.sent.findLast((m) => m.type === 'ui.auth')
    this.reply('ui.ready', { user_id: newId(), tenant_id: newId(), role: 'owner' }, auth?.id)
  }
  binary(bytes: number[]) {
    this.emit('message', { data: new Uint8Array(bytes).buffer })
  }
}

afterEach(() => {
  FakeSocket.all = []
  vi.useRealTimers()
})

function socket(token = 'token-1') {
  let current: string | undefined = token
  const ui = new UiSocket({
    url: 'ws://localhost/api/ws/ui',
    token: () => current,
    create: (url) => new FakeSocket(url),
    minBackoffMs: 100,
    maxBackoffMs: 400,
  })
  return { ui, setToken: (t: string | undefined) => (current = t) }
}

describe('UiSocket (contracts/ui-ws.md)', () => {
  it('builds the URL from the page origin', () => {
    expect(uiSocketUrl({ protocol: 'https:', host: 'coral.example' })).toBe(
      'wss://coral.example/api/ws/ui',
    )
    expect(uiSocketUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/api/ws/ui',
    )
  })

  it('authenticates first and holds messages until ready', () => {
    const { ui } = socket()
    ui.connect()
    const fake = FakeSocket.all[0]!
    ui.send('run.watch', { run_id: newId() })
    fake.open()
    expect(fake.sent.map((m) => m.type)).toEqual(['ui.auth'])
    expect(fake.sent[0]?.payload).toEqual({ access_token: 'token-1' })
    fake.ready()
    expect(ui.status).toBe('ready')
    expect(fake.sent.map((m) => m.type)).toEqual(['ui.auth', 'run.watch'])
  })

  it('does not connect without a token', () => {
    const { ui } = socket()
    const empty = new UiSocket({
      url: 'x',
      token: () => undefined,
      create: (url) => new FakeSocket(url),
    })
    empty.connect()
    expect(FakeSocket.all).toHaveLength(0)
    expect(ui.status).toBe('idle')
  })

  it('reconnects with backoff and re-subscribes', async () => {
    vi.useFakeTimers()
    const { ui } = socket()
    const run_id = newId()
    ui.onReady(() => ui.send('run.watch', { run_id }))
    ui.connect()
    FakeSocket.all[0]!.open()
    FakeSocket.all[0]!.ready()
    FakeSocket.all[0]!.close()
    expect(ui.status).toBe('connecting')
    await vi.advanceTimersByTimeAsync(99)
    expect(FakeSocket.all).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    const second = FakeSocket.all[1]!
    second.open()
    second.ready()
    expect(second.sent.map((m) => m.type)).toEqual(['ui.auth', 'run.watch'])
    expect(second.sent[1]?.payload).toEqual({ run_id })
  })

  it('renews auth on the same connection after a refresh', () => {
    const { ui, setToken } = socket()
    ui.connect()
    const fake = FakeSocket.all[0]!
    fake.open()
    fake.ready()
    setToken('token-2')
    ui.renew()
    expect(fake.sent.at(-1)).toMatchObject({
      type: 'ui.auth',
      payload: { access_token: 'token-2' },
    })
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('resolves requests by re, dispatches messages and binary frames', async () => {
    const { ui } = socket()
    const frames: number[][] = []
    const devices: unknown[] = []
    ui.onBinary((frame) => frames.push([...frame]))
    ui.on('devices.updated', (m) => devices.push(m.payload.devices))
    ui.connect()
    const fake = FakeSocket.all[0]!
    fake.open()
    fake.ready()
    const answer = ui.request('live.command', {
      live_session_id: newId(),
      command: { kind: 'back' },
    })
    const sent = fake.sent.at(-1)!
    fake.reply('live.result', { ok: true, command_id: newId(), duration_ms: 12 }, sent.id)
    await expect(answer).resolves.toMatchObject({ type: 'live.result', payload: { ok: true } })
    fake.reply('devices.updated', { devices: [] })
    fake.binary([1, 2, 3])
    expect(devices).toEqual([[]])
    expect(frames).toEqual([[1, 2, 3]])
  })

  it('stays closed after close()', async () => {
    vi.useFakeTimers()
    const { ui } = socket()
    ui.connect()
    FakeSocket.all[0]!.open()
    ui.close()
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeSocket.all).toHaveLength(1)
    expect(ui.status).toBe('closed')
  })
})
