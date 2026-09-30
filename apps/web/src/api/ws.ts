import { protocol } from '@coral/shared'

type UiMessage = protocol.UiMessage
type UiMessageType = protocol.UiMessageType
type UiPayload<T extends UiMessageType> = protocol.UiPayload<T>
type Handler<T extends UiMessageType> = (message: Extract<UiMessage, { type: T }>) => void

/** The subset of the browser WebSocket this class uses (tests pass a fake). */
export interface SocketLike {
  readonly readyState: number
  binaryType: string
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'close' | 'message', listener: (event: never) => void): void
}

export interface UiSocketOptions {
  url: string
  /** The current access token; the socket cannot connect without one. */
  token: () => string | undefined
  create?: (url: string) => SocketLike
  /** Backoff after a drop: min, doubled up to max (defaults 1 s → 15 s). */
  minBackoffMs?: number
  maxBackoffMs?: number
}

export type UiSocketState = 'idle' | 'connecting' | 'ready' | 'closed'

const OPEN = 1

/** `ws(s)://<host>/api/ws/ui` for the page's origin. */
export function uiSocketUrl(location: Pick<Location, 'protocol' | 'host'>): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/ui`
}

/**
 * The tab's one connection to `WS /ws/ui` (contracts/ui-ws.md): authenticates in-band, queues
 * messages until ready, reconnects with backoff and re-runs `onReady` hooks so subscriptions
 * (run.watch, stream.subscribe) come back; `renew()` re-sends ui.auth after a token refresh.
 */
export class UiSocket {
  private socket: SocketLike | undefined
  private state: UiSocketState = 'idle'
  private backoff: number
  private retry: ReturnType<typeof setTimeout> | undefined
  private readonly queue: string[] = []
  private readonly handlers = new Map<UiMessageType, Set<(message: UiMessage) => void>>()
  private readonly binaryHandlers = new Set<(frame: Uint8Array) => void>()
  private readonly readyHooks = new Set<() => void>()
  private readonly stateListeners = new Set<(state: UiSocketState) => void>()
  private readonly pending = new Map<string, (message: UiMessage) => void>()
  private authId: string | undefined

  constructor(private readonly options: UiSocketOptions) {
    this.backoff = options.minBackoffMs ?? 1000
  }

  get status(): UiSocketState {
    return this.state
  }

  /** Opens the connection (no-op when open or opening). */
  connect(): void {
    if (this.socket || !this.options.token()) return
    this.setState('connecting')
    const socket = (this.options.create ?? ((url) => new WebSocket(url) as unknown as SocketLike))(
      this.options.url,
    )
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    socket.addEventListener('open', () => this.authenticate())
    socket.addEventListener('message', (event: MessageEvent) => this.receive(event.data))
    socket.addEventListener('close', () => this.dropped(socket))
  }

  /** Closes for good (sign out). */
  close(): void {
    if (this.retry) clearTimeout(this.retry)
    this.retry = undefined
    const socket = this.socket
    this.socket = undefined
    this.queue.length = 0
    this.setState('closed')
    socket?.close(1000, 'bye')
  }

  /** Sends ui.auth with the current token again (after a refresh). */
  renew(): void {
    if (this.socket?.readyState === OPEN) this.authenticate()
    else this.connect()
  }

  on<T extends UiMessageType>(type: T, handler: Handler<T>): () => void {
    const set = this.handlers.get(type) ?? new Set()
    const wrapped = handler as (message: UiMessage) => void
    set.add(wrapped)
    this.handlers.set(type, set)
    return () => set.delete(wrapped)
  }

  onBinary(handler: (frame: Uint8Array) => void): () => void {
    this.binaryHandlers.add(handler)
    return () => this.binaryHandlers.delete(handler)
  }

  /** Runs now if ready, and after every (re)connection: re-subscribe here. */
  onReady(hook: () => void): () => void {
    this.readyHooks.add(hook)
    if (this.state === 'ready') hook()
    return () => this.readyHooks.delete(hook)
  }

  onState(listener: (state: UiSocketState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /** Sends now when ready, else when ready. Returns the message id. */
  send<T extends UiMessageType>(type: T, payload: UiPayload<T>): string {
    const message = protocol.envelope(type, payload)
    const raw = JSON.stringify(message)
    if (this.state === 'ready' && this.socket?.readyState === OPEN) this.socket.send(raw)
    else this.queue.push(raw)
    return message.id
  }

  /** Sends and resolves with the reply (`re`) — `live.result`, `live.inspected` or `error`. */
  request<T extends UiMessageType>(
    type: T,
    payload: UiPayload<T>,
    timeoutMs = 15_000,
  ): Promise<UiMessage> {
    const id = this.send(type, payload)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`no answer to ${type} within ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
    })
  }

  private authenticate(): void {
    const token = this.options.token()
    if (!token || !this.socket) return
    const message = protocol.envelope('ui.auth', { access_token: token })
    this.authId = message.id
    this.socket.send(JSON.stringify(message))
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array)
      for (const handler of this.binaryHandlers) handler(bytes)
      return
    }
    const parsed = protocol.parseUiMessage(data)
    if (!parsed.ok) return
    const message = parsed.message
    if (message.type === 'ui.ready' && message.re === this.authId) {
      this.ready()
    }
    if (message.re) {
      const waiter = this.pending.get(message.re)
      if (waiter) {
        this.pending.delete(message.re)
        waiter(message)
      }
    }
    for (const handler of this.handlers.get(message.type) ?? []) handler(message)
  }

  private ready(): void {
    const first = this.state !== 'ready'
    this.backoff = this.options.minBackoffMs ?? 1000
    this.setState('ready')
    if (!first) return
    for (const hook of this.readyHooks) hook()
    for (const raw of this.queue.splice(0)) this.socket?.send(raw)
  }

  private dropped(socket: SocketLike): void {
    if (this.socket !== socket) return
    this.socket = undefined
    if (this.state === 'closed') return
    this.setState('connecting')
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs ?? 15_000)
    this.retry = setTimeout(() => {
      this.retry = undefined
      if (this.state !== 'closed') this.connect()
    }, delay)
  }

  private setState(state: UiSocketState): void {
    if (this.state === state) return
    this.state = state
    for (const listener of this.stateListeners) listener(state)
  }
}
