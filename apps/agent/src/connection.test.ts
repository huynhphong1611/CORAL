import type { AddressInfo } from 'node:net'
import { protocol } from '@coral/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { AgentConnection, MAX_QUEUED, UNAUTHORIZED } from './connection'

const AGENT_ID = '0192f000-0000-7000-8000-00000000000a'
const RUN_ID = '0192f000-0000-7000-8000-00000000000b'

interface Received {
  type: string
  id: string
  re?: string
  payload: unknown
}

/** In-process stand-in for coral-server's /ws/agent. */
async function fakeServer(opts: { heartbeatMs?: number; rejectToken?: boolean } = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const received: Received[] = []
  const auth: (string | undefined)[] = []
  const sockets: WebSocket[] = []
  const binaries: Uint8Array[] = []
  wss.on('connection', (socket, request) => {
    auth.push(request.headers.authorization)
    if (opts.rejectToken) {
      socket.close(UNAUTHORIZED, 'invalid token')
      return
    }
    sockets.push(socket)
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        binaries.push(new Uint8Array(data as Buffer))
        return
      }
      const message = JSON.parse(Buffer.from(data as Buffer).toString()) as Received
      received.push(message)
      if (message.type === 'agent.hello') {
        socket.send(
          JSON.stringify(
            protocol.envelope(
              'agent.welcome',
              { agent_id: AGENT_ID, heartbeat_ms: opts.heartbeatMs ?? 60_000 },
              message.id,
            ),
          ),
        )
      }
      if (message.type === 'artifact.request_upload') {
        socket.send(
          JSON.stringify(protocol.envelope('artifact.upload_url', { uploads: [] }, message.id)),
        )
      }
    })
  })
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws/agent`
  return {
    url,
    received,
    binaries,
    auth,
    sockets,
    types: () => received.map((m) => m.type),
    close: () => new Promise<void>((r) => wss.close(() => r())),
  }
}

const until = async (check: () => boolean, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const hello = () => ({
  agent_version: '0.1.0',
  os: 'linux',
  arch: 'x64',
  capabilities: { platforms: ['android' as const], u2_jar: '0.4.0' },
  devices: [],
})

let cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

function connect(
  url: string,
  extra: Partial<ConstructorParameters<typeof AgentConnection>[0]> = {},
) {
  const messages: protocol.Message[] = []
  const conn = new AgentConnection({
    url,
    token: 'coral_agt_test_token_123456789',
    hello,
    heartbeat: () => ({ devices: [] }),
    onMessage: (m) => messages.push(m),
    minBackoffMs: 20,
    maxBackoffMs: 80,
    ...extra,
  })
  conn.start()
  cleanup.push(() => conn.stop())
  return { conn, messages }
}

describe('AgentConnection', () => {
  it('sends binary frames once connected and never queues them', async () => {
    const server = await fakeServer()
    cleanup.push(server.close)
    const { conn } = connect(server.url)
    expect(await conn.sendBinary(Uint8Array.from([9, 9]))).toBe(false)
    await until(() => conn.connected)
    expect(await conn.sendBinary(Uint8Array.from([1, 2, 3]))).toBe(true)
    await until(() => server.binaries.length === 1)
    expect([...(server.binaries[0] ?? [])]).toEqual([1, 2, 3])
  })

  it('sends the token, says hello, heartbeats at the server pace', async () => {
    const server = await fakeServer({ heartbeatMs: 50 })
    cleanup.push(server.close)
    const { conn } = connect(server.url)
    await until(() => conn.connected)
    expect(server.auth[0]).toBe('Bearer coral_agt_test_token_123456789')
    expect(conn.agentId).toBe(AGENT_ID)
    await until(() => server.types().filter((t) => t === 'agent.heartbeat').length >= 2)
    expect(server.types()[0]).toBe('agent.hello')
  })

  it('validates incoming messages and routes job messages and replies', async () => {
    const server = await fakeServer()
    cleanup.push(server.close)
    const { conn, messages } = connect(server.url)
    await until(() => conn.connected)
    server.sockets[0]?.send('{broken')
    await until(() => server.types().includes('error'))
    server.sockets[0]?.send(
      JSON.stringify(protocol.envelope('job.cancel', { run_id: RUN_ID, reason: 'user' })),
    )
    await until(() => messages.length === 1)
    expect(messages[0]?.type).toBe('job.cancel')

    const reply = await conn.request('artifact.request_upload', {
      run_id: RUN_ID,
      run_item_id: RUN_ID,
      step_index: 0,
      step_id: 's1',
      files: [{ name: 'tree.json', content_type: 'application/json', size_bytes: 2 }],
    })
    expect(reply.type).toBe('artifact.upload_url')
    expect(messages).toHaveLength(1)
  })

  it('keeps messages while disconnected and sends them after reconnecting', async () => {
    const server = await fakeServer()
    cleanup.push(server.close)
    const { conn } = connect(server.url)
    await until(() => conn.connected)
    server.sockets[0]?.terminate()
    await until(() => !conn.connected)
    conn.send('job.ack', { run_id: RUN_ID })
    await until(() => server.types().filter((t) => t === 'agent.hello').length === 2)
    await until(() => server.types().includes('job.ack'))
    const types = server.types()
    // The queued message goes out after the second hello/welcome.
    expect(types.lastIndexOf('agent.hello')).toBeLessThan(types.indexOf('job.ack'))
  })

  it(`keeps at most ${MAX_QUEUED} messages, dropping the oldest`, async () => {
    const conn = new AgentConnection({
      url: 'ws://127.0.0.1:9/ws/agent',
      token: 't',
      hello,
      heartbeat: () => ({ devices: [] }),
      onMessage: () => undefined,
    })
    for (let i = 0; i < MAX_QUEUED + 5; i++) conn.send('agent.heartbeat', { devices: [] })
    expect((conn as unknown as { queue: string[] }).queue).toHaveLength(MAX_QUEUED)
  })

  it('stops reconnecting when the server refuses the token (4401)', async () => {
    const server = await fakeServer({ rejectToken: true })
    cleanup.push(server.close)
    let refused = 0
    const { conn } = connect(server.url, { onUnauthorized: () => void refused++ })
    await until(() => refused === 1)
    await new Promise((r) => setTimeout(r, 150))
    expect(server.auth).toHaveLength(1)
    expect(conn.connected).toBe(false)
  })
})
