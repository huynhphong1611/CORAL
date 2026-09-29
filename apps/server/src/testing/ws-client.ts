import { protocol } from '@coral/shared'
import WebSocket from 'ws'

export interface ReceivedMessage {
  type: string
  id: string
  re?: string
  payload: unknown
}

/** Minimal agent-side WebSocket for server tests: records messages and the close code. */
export async function connectAgent(baseUrl: string, token: string | undefined) {
  const url = `${baseUrl.replace(/^http/, 'ws')}/ws/agent`
  const ws = new WebSocket(url, token ? { headers: { authorization: `Bearer ${token}` } } : {})
  const received: ReceivedMessage[] = []
  const waiters: {
    match: (m: ReceivedMessage) => boolean
    done: (m: ReceivedMessage) => void
  }[] = []
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  )
  ws.on('message', (data) => {
    const message = JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as ReceivedMessage
    received.push(message)
    for (const waiter of [...waiters]) {
      if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.done(message)
      }
    }
  })
  await new Promise<void>((resolve) => {
    ws.once('open', () => resolve())
    ws.once('close', () => resolve())
    ws.once('error', () => resolve())
  })

  function send<T extends protocol.MessageType>(
    type: T,
    payload: protocol.Payload<T>,
    re?: string,
  ) {
    const message = protocol.envelope(type, payload, re)
    ws.send(JSON.stringify(message))
    return message
  }

  /** Next message matching `type` (and `re` when given), including ones already received. */
  function next(type: string, re?: string, timeoutMs = 5000): Promise<ReceivedMessage> {
    const match = (m: ReceivedMessage) => m.type === type && (re === undefined || m.re === re)
    const seen = received.find(match)
    if (seen) {
      received.splice(received.indexOf(seen), 1)
      return Promise.resolve(seen)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no ${type} within ${timeoutMs} ms`)),
        timeoutMs,
      )
      waiters.push({
        match,
        done: (m) => {
          clearTimeout(timer)
          received.splice(received.indexOf(m), 1)
          resolve(m)
        },
      })
    })
  }

  let beat: NodeJS.Timeout | undefined
  /** Sends agent.heartbeat every `ms` like a real agent (tests with a short heartbeat). */
  function heartbeat(ms: number) {
    beat = setInterval(() => {
      if (ws.readyState === ws.OPEN) send('agent.heartbeat', { devices: [] })
    }, ms)
    void closed.then(() => clearInterval(beat))
  }

  return {
    ws,
    received,
    closed,
    send,
    next,
    heartbeat,
    /** Simulates a frozen agent: the socket stays open but nothing is sent any more. */
    stopHeartbeat: () => clearInterval(beat),
    close: () => {
      clearInterval(beat)
      ws.close()
    },
  }
}

export const emulator = (udid = 'emulator-5554'): protocol.DeviceInfo => ({
  udid,
  platform: 'android',
  kind: 'emulator',
  model: 'sdk_gphone64_x86_64',
  os_version: '14',
  api_level: 34,
  status: 'idle',
})

export const hello = (devices: protocol.DeviceInfo[]) => ({
  agent_version: '0.1.0',
  os: 'linux',
  arch: 'x64',
  capabilities: { platforms: ['android' as const], u2_jar: '0.4.0' },
  devices,
})
