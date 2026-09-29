import { protocol } from '@coral/shared'
import WebSocket from 'ws'
import type { ReceivedMessage } from './ws-client'

/** A browser tab on `WS /ws/ui` for server tests: JSON messages, binary frames, close code. */
export async function connectUi(baseUrl: string) {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws/ui`)
  const received: ReceivedMessage[] = []
  const binaries: Uint8Array[] = []
  const waiters: { match: (m: ReceivedMessage) => boolean; done: (m: ReceivedMessage) => void }[] =
    []
  const binaryWaiters: ((frame: Uint8Array) => void)[] = []
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  )
  ws.on('message', (data, isBinary) => {
    const bytes = new Uint8Array(data as Buffer)
    if (isBinary) {
      const waiter = binaryWaiters.shift()
      if (waiter) waiter(bytes)
      else binaries.push(bytes)
      return
    }
    const message = JSON.parse(Buffer.from(bytes).toString('utf8')) as ReceivedMessage
    const waiter = waiters.find((w) => w.match(message))
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.done(message)
    } else {
      received.push(message)
    }
  })
  await new Promise<void>((resolve) => {
    ws.once('open', () => resolve())
    ws.once('close', () => resolve())
    ws.once('error', () => resolve())
  })

  function send<T extends protocol.UiMessageType>(
    type: T,
    payload: protocol.UiPayload<T>,
    re?: string,
  ) {
    const message = protocol.envelope(type, payload, re)
    ws.send(JSON.stringify(message))
    return message
  }

  /** Next message of `type` (and `re` when given), including ones already received. */
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
          resolve(m)
        },
      })
    })
  }

  function nextBinary(timeoutMs = 5000): Promise<Uint8Array> {
    const seen = binaries.shift()
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no binary frame within ${timeoutMs} ms`)),
        timeoutMs,
      )
      binaryWaiters.push((frame) => {
        clearTimeout(timer)
        resolve(frame)
      })
    })
  }

  /** Sends ui.auth and waits for ui.ready. */
  async function auth(accessToken: string) {
    const request = send('ui.auth', { access_token: accessToken })
    return next('ui.ready', request.id)
  }

  return {
    ws,
    received,
    binaries,
    closed,
    send,
    next,
    nextBinary,
    auth,
    close: () => ws.close(),
  }
}

export type UiClient = Awaited<ReturnType<typeof connectUi>>
