import { newId, protocol } from '@coral/shared'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { verifyAccessSession, type AccessClaims } from '../auth/tokens'

type UiMessage = protocol.UiMessage
type UiMessageType = protocol.UiMessageType
type UiPayload<T extends UiMessageType> = protocol.UiPayload<T>

/** Close codes of `WS /ws/ui` (contracts/ui-ws.md). */
export const UI_CLOSE = {
  unauthorized: 4401,
  tooManyInvalid: 4400,
  shutdown: 1001,
} as const

export const UI_MAX_INVALID_PER_MINUTE = 20

export interface UiUser {
  userId: string
  tenantId: string
  role: AccessClaims['role']
}

/** One browser tab's connection, once authenticated. */
export interface UiConnection {
  readonly id: string
  readonly user: UiUser
}

export interface UiContext {
  connection: UiConnection
  /** Sends a reply (`re` = the message being handled). */
  reply<T extends UiMessageType>(type: T, payload: UiPayload<T>): void
  /** Sends an error reply. */
  fail(code: string, message: string): void
}

export type UiHandler<T extends UiMessageType = UiMessageType> = (
  ctx: UiContext,
  message: Extract<UiMessage, { type: T }>,
) => Promise<void> | void

interface Connection {
  id: string
  socket: WebSocket
  user: UiUser | undefined
  expiresAt: number
  invalidAt: number[]
  queue: Promise<void>
}

export interface UiGatewayOptions {
  jwtSecret: string
  /** First message must be ui.auth within this time (default 5 s). */
  authTimeoutMs?: number
  /** How often expired sessions are closed (default 30 s). */
  expiryCheckMs?: number
}

/**
 * `WS /ws/ui` (contracts/ui-ws.md, research R3): browsers cannot set Authorization on a
 * WebSocket, so the first message is `ui.auth { access_token }`; a later ui.auth renews it.
 * Every connection belongs to one user in one tenant (P5); handlers route the rest.
 */
export class UiGateway {
  private readonly connections = new Map<string, Connection>()
  private readonly handlers = new Map<
    UiMessageType,
    (ctx: UiContext, message: UiMessage) => Promise<void> | void
  >()
  private readonly closeListeners: ((connection: UiConnection) => Promise<void> | void)[] = []
  private timer: NodeJS.Timeout | undefined
  private log: FastifyBaseLogger | undefined

  constructor(private readonly options: UiGatewayOptions) {}

  /** Adds the route; the websocket plugin is registered once by buildServer. */
  register(app: FastifyInstance): void {
    this.log = app.log
    void app.register(async (instance) => {
      // Public at the HTTP level: the token comes in-band (ui.auth).
      instance.get('/ws/ui', { websocket: true, config: { public: true } }, (socket) => {
        this.accept(socket)
      })
    })
    app.addHook('onClose', async () => this.stop())
    const every = this.options.expiryCheckMs ?? 30_000
    this.timer = setInterval(() => this.closeExpired(), every)
    this.timer.unref()
  }

  on<T extends UiMessageType>(type: T, handler: UiHandler<T>): void {
    this.handlers.set(type, (ctx, message) =>
      handler(ctx, message as Extract<UiMessage, { type: T }>),
    )
  }

  /** Called when an authenticated connection closes (viewers, watches…). */
  onClose(listener: (connection: UiConnection) => Promise<void> | void): void {
    this.closeListeners.push(listener)
  }

  /** Authenticated connections of a tenant. */
  connectionsOf(tenantId: string): UiConnection[] {
    return [...this.connections.values()]
      .filter((c) => c.user?.tenantId === tenantId)
      .map((c) => ({ id: c.id, user: c.user as UiUser }))
  }

  /** Sends to one connection; false when it is gone. */
  sendTo<T extends UiMessageType>(
    connectionId: string,
    type: T,
    payload: UiPayload<T>,
    re?: string,
  ): boolean {
    const connection = this.connections.get(connectionId)
    if (!connection?.user) return false
    return this.sendRaw(connection, type, payload, re)
  }

  /** Sends to every connection of the tenant (optionally filtered); returns how many got it. */
  broadcastToTenant<T extends UiMessageType>(
    tenantId: string,
    type: T,
    payload: UiPayload<T>,
    filter: (connection: UiConnection) => boolean = () => true,
  ): number {
    let sent = 0
    for (const connection of this.connectionsOf(tenantId)) {
      if (filter(connection) && this.sendTo(connection.id, type, payload)) sent += 1
    }
    return sent
  }

  /**
   * Sends a binary frame unless the connection already has more than `maxBuffered` bytes queued
   * (a slow viewer drops frames instead of slowing the others — research R5).
   */
  sendBinary(connectionId: string, bytes: Uint8Array, maxBuffered = 1024 * 1024): boolean {
    const connection = this.connections.get(connectionId)
    if (!connection?.user || connection.socket.readyState !== connection.socket.OPEN) return false
    if (connection.socket.bufferedAmount > maxBuffered) return false
    connection.socket.send(bytes, { binary: true })
    return true
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const connection of [...this.connections.values()]) {
      connection.socket.close(UI_CLOSE.shutdown, 'server shutting down')
    }
    this.connections.clear()
  }

  private accept(socket: WebSocket): void {
    const connection: Connection = {
      id: newId(),
      socket,
      user: undefined,
      expiresAt: 0,
      invalidAt: [],
      queue: Promise.resolve(),
    }
    this.connections.set(connection.id, connection)
    const authTimer = setTimeout(() => {
      if (!connection.user) socket.close(UI_CLOSE.unauthorized, 'ui.auth expected first')
    }, this.options.authTimeoutMs ?? 5000)
    authTimer.unref()
    socket.on('message', (data, isBinary) => {
      const raw = isBinary ? undefined : Buffer.from(data as Buffer).toString('utf8')
      // In order, one at a time per tab.
      connection.queue = connection.queue
        .then(() => this.handle(connection, raw))
        .catch((error: unknown) =>
          this.log?.error({ err: error, connection: connection.id }, 'ui message failed'),
        )
    })
    socket.on('close', () => {
      clearTimeout(authTimer)
      if (this.connections.get(connection.id) !== connection) return
      this.connections.delete(connection.id)
      const user = connection.user
      if (!user) return
      for (const listener of this.closeListeners) {
        void Promise.resolve(listener({ id: connection.id, user })).catch((error: unknown) =>
          this.log?.error({ err: error }, 'ui close listener failed'),
        )
      }
    })
  }

  private closeExpired(): void {
    const now = Date.now()
    for (const connection of this.connections.values()) {
      if (connection.user && connection.expiresAt < now) {
        connection.socket.close(UI_CLOSE.unauthorized, 'session expired; send ui.auth')
      }
    }
  }

  private sendRaw(
    connection: Connection,
    type: UiMessageType,
    payload: unknown,
    re?: string,
  ): boolean {
    if (connection.socket.readyState !== connection.socket.OPEN) return false
    connection.socket.send(JSON.stringify(protocol.envelope(type, payload, re)))
    return true
  }

  private invalid(connection: Connection, message: string, re?: string): void {
    this.sendRaw(connection, 'error', { code: 'invalid_message', message }, re)
    const now = Date.now()
    connection.invalidAt = [...connection.invalidAt.filter((t) => now - t < 60_000), now]
    if (connection.invalidAt.length > UI_MAX_INVALID_PER_MINUTE) {
      connection.socket.close(UI_CLOSE.tooManyInvalid, 'too many invalid messages')
    }
  }

  private async authenticate(
    connection: Connection,
    message: Extract<UiMessage, { type: 'ui.auth' }>,
  ) {
    const session = await verifyAccessSession(message.payload.access_token, this.options.jwtSecret)
    const same =
      !connection.user ||
      (session?.sub === connection.user.userId && session.tid === connection.user.tenantId)
    if (!session || !same) {
      connection.socket.close(UI_CLOSE.unauthorized, 'invalid or expired access token')
      return
    }
    connection.user = { userId: session.sub, tenantId: session.tid, role: session.role }
    connection.expiresAt = session.expiresAt
    this.sendRaw(
      connection,
      'ui.ready',
      { user_id: session.sub, tenant_id: session.tid, role: session.role },
      message.id,
    )
  }

  private async handle(connection: Connection, raw: string | undefined): Promise<void> {
    if (raw === undefined) {
      this.invalid(connection, 'binary messages are not accepted from browsers')
      return
    }
    const parsed = protocol.parseUiMessage(raw)
    if (!parsed.ok) {
      if (!connection.user) {
        connection.socket.close(UI_CLOSE.unauthorized, 'ui.auth expected first')
        return
      }
      this.invalid(connection, parsed.message, parsed.id)
      return
    }
    const message = parsed.message
    if (message.type === 'ui.auth') {
      await this.authenticate(connection, message)
      return
    }
    if (message.type === 'error') {
      this.log?.warn(
        { connection: connection.id, error: message.payload },
        'browser reported an error',
      )
      return
    }
    if (!connection.user) {
      connection.socket.close(UI_CLOSE.unauthorized, 'ui.auth expected first')
      return
    }
    if (protocol.UI_MESSAGE_DIRECTION[message.type] === 'S→C') {
      this.invalid(connection, `${message.type} is sent by the server`, message.id)
      return
    }
    const handler = this.handlers.get(message.type)
    if (!handler) {
      this.sendRaw(
        connection,
        'error',
        { code: 'unsupported', message: `${message.type} is not available` },
        message.id,
      )
      return
    }
    const user = connection.user
    await handler(
      {
        connection: { id: connection.id, user },
        reply: (type, payload) => this.sendRaw(connection, type, payload, message.id),
        fail: (code, text) =>
          this.sendRaw(connection, 'error', { code, message: text }, message.id),
      },
      message,
    )
  }
}
