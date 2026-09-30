import { protocol } from '@coral/shared'
import type { Logger } from 'pino'
import WebSocket from 'ws'

type Message = protocol.Message
type MessageType = protocol.MessageType
type Payload<T extends MessageType> = protocol.Payload<T>

export const UNAUTHORIZED = 4401
export const MAX_QUEUED = 200

export interface ConnectionOptions {
  url: string
  token: string
  /** Built on every (re)connect so the device list is current. */
  hello: () => Promise<Payload<'agent.hello'>> | Payload<'agent.hello'>
  heartbeat: () => Payload<'agent.heartbeat'>
  /** Server messages that are not replies to a request (job.assign, job.cancel, error). */
  onMessage: (message: Message) => void
  onWelcome?: (welcome: Payload<'agent.welcome'>) => void
  /** The server refused the token (4401): reconnecting will not help. */
  onUnauthorized?: () => void
  log?: Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>
  minBackoffMs?: number
  maxBackoffMs?: number
  requestTimeoutMs?: number
}

interface Pending {
  resolve: (message: Message) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * The agent's single WebSocket to the server (contracts/ws-protocol.md): Authorization header,
 * hello → welcome, heartbeat at the server's pace, reconnect with backoff 1 → 30 s, and up to
 * 200 outgoing messages kept while disconnected. Every incoming message is validated.
 */
export class AgentConnection {
  private ws: WebSocket | undefined
  private ready = false
  private stopped = false
  private backoff: number
  private heartbeatTimer: NodeJS.Timeout | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private readonly queue: string[] = []
  private readonly pending = new Map<string, Pending>()
  agentId: string | undefined

  constructor(private readonly options: ConnectionOptions) {
    this.backoff = options.minBackoffMs ?? 1000
  }

  get connected(): boolean {
    return this.ready
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    this.stopHeartbeat()
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('connection stopped'))
    }
    this.pending.clear()
    const ws = this.ws
    if (!ws || ws.readyState === ws.CLOSED) return
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve())
      ws.close(1000, 'agent shutting down')
      setTimeout(() => {
        ws.terminate()
        resolve()
      }, 2000).unref()
    })
  }

  /** Sends now, or keeps it (up to 200, oldest dropped first) until the next welcome. */
  send<T extends MessageType>(type: T, payload: Payload<T>, re?: string): string {
    const message = protocol.envelope(type, payload, re)
    const raw = JSON.stringify(message)
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(raw)
    } else {
      this.queue.push(raw)
      if (this.queue.length > MAX_QUEUED) {
        this.queue.shift()
        this.options.log?.warn('outgoing queue full: dropped the oldest message')
      }
    }
    return message.id
  }

  /**
   * Sends a binary frame (live view) and resolves once it is written to the socket, so the caller
   * sends the next one only then (research R4). Never queued: false when not connected.
   */
  sendBinary(bytes: Uint8Array): Promise<boolean> {
    const ws = this.ws
    if (!this.ready || ws?.readyState !== WebSocket.OPEN) return Promise.resolve(false)
    return new Promise((resolve) => {
      ws.send(bytes, { binary: true }, (error) => resolve(!error))
    })
  }

  /** Sends a message and resolves with the server's reply (`re` = its id). */
  request<T extends MessageType>(type: T, payload: Payload<T>): Promise<Message> {
    const id = this.send(type, payload)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`no reply to ${type}`))
      }, this.options.requestTimeoutMs ?? 30_000)
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  private connect(): void {
    if (this.stopped) return
    const ws = new WebSocket(this.options.url, {
      headers: { authorization: `Bearer ${this.options.token}` },
      maxPayload: protocol.MAX_MESSAGE_BYTES,
    })
    this.ws = ws
    let helloId: string | undefined

    ws.on('open', () => {
      void Promise.resolve(this.options.hello()).then((payload) => {
        const hello = protocol.envelope('agent.hello', payload)
        helloId = hello.id
        ws.send(JSON.stringify(hello))
      })
    })

    ws.on('message', (data, isBinary) => {
      const parsed = protocol.parseMessage(
        isBinary ? '' : Buffer.from(data as Buffer).toString('utf8'),
      )
      if (!parsed.ok) {
        this.options.log?.warn(
          { code: parsed.code },
          `invalid message from server: ${parsed.message}`,
        )
        ws.send(
          JSON.stringify(
            protocol.envelope(
              'error',
              { code: 'invalid_message', message: parsed.message },
              parsed.id,
            ),
          ),
        )
        return
      }
      const message = parsed.message
      if (protocol.MESSAGE_DIRECTION[message.type] === 'A→S') {
        this.options.log?.warn({ type: message.type }, 'server sent an agent-only message type')
        return
      }
      if (message.type === 'agent.welcome' && message.re === helloId) {
        this.welcomed(message.payload)
        return
      }
      const pending = message.re ? this.pending.get(message.re) : undefined
      if (pending && message.re) {
        this.pending.delete(message.re)
        clearTimeout(pending.timer)
        pending.resolve(message)
        return
      }
      this.options.onMessage(message)
    })

    ws.on('close', (code, reason) => {
      const wasReady = this.ready
      this.ready = false
      this.stopHeartbeat()
      if (code === UNAUTHORIZED) {
        this.options.log?.error({ reason: reason.toString() }, 'server refused the agent token')
        this.stopped = true
        this.options.onUnauthorized?.()
        return
      }
      if (this.stopped) return
      if (wasReady) this.options.log?.warn({ code }, 'disconnected from server')
      const delay = this.backoff
      this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs ?? 30_000)
      this.reconnectTimer = setTimeout(() => this.connect(), delay)
    })

    // 'close' follows 'error'; nothing else to do here but avoid an unhandled error event.
    ws.on('error', (error) => this.options.log?.debug({ err: error }, 'websocket error'))
  }

  private welcomed(welcome: Payload<'agent.welcome'>): void {
    this.ready = true
    this.agentId = welcome.agent_id
    this.backoff = this.options.minBackoffMs ?? 1000
    this.options.log?.info({ agent_id: welcome.agent_id }, 'connected to server')
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ready) this.send('agent.heartbeat', this.options.heartbeat())
    }, welcome.heartbeat_ms)
    this.heartbeatTimer.unref()
    for (const raw of this.queue.splice(0)) this.ws?.send(raw)
    this.options.onWelcome?.(welcome)
  }

  private stopHeartbeat(): void {
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }
}
