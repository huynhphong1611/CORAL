import { protocol } from '@coral/shared'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { Db } from '../db/client'
import { agentSessionRepo, type AgentSessionRepo } from '../repos/agent-session'
import { findAgentByToken } from '../repos/agents'
import type { AgentConnections } from '../routes/agents'

type Message = protocol.Message
type MessageType = protocol.MessageType
type Payload<T extends MessageType> = protocol.Payload<T>

/** WebSocket close codes of contracts/ws-protocol.md (+ coral-specific 44xx). */
export const CLOSE = {
  unauthorized: 4401,
  tooManyInvalid: 4400,
  heartbeatTimeout: 4408,
  replaced: 4409,
  shutdown: 1001,
} as const

/** Invalid messages tolerated per minute before the connection is closed (4400). */
export const MAX_INVALID_PER_MINUTE = 20
/** Heartbeats an agent may miss before it is offline (research R9). */
export const MISSED_HEARTBEATS = 3

export interface AgentRef {
  id: string
  tenantId: string
  name: string
}

export interface AgentContext {
  agent: AgentRef
  session: AgentSessionRepo
  /** Sends a reply to the message being handled. */
  reply<T extends MessageType>(type: T, payload: Payload<T>): void
}

export type MessageHandler<T extends MessageType = MessageType> = (
  ctx: AgentContext,
  message: Extract<Message, { type: T }>,
) => Promise<void> | void

interface Connection {
  agent: AgentRef
  socket: WebSocket
  session: AgentSessionRepo
  lastSeen: number
  hello: boolean
  invalidAt: number[]
  queue: Promise<void>
}

export interface GatewayOptions {
  db: Db
  heartbeatMs: number
  /** Lease extension on each heartbeat (default 4 × heartbeat = 60 s, research R9). */
  leaseTtlMs?: number
}

/**
 * `WS /ws/agent` (SPEC §15, contracts/ws-protocol.md): authenticates the agent token, keeps the
 * agent/device state in the DB, detects missed heartbeats and routes run messages to handlers.
 */
export class AgentGateway implements AgentConnections {
  private readonly connections = new Map<string, Connection>()
  private readonly handlers = new Map<
    MessageType,
    (ctx: AgentContext, message: Message) => Promise<void> | void
  >()
  private readonly offlineListeners: ((agent: AgentRef) => Promise<void> | void)[] = []
  private timer: NodeJS.Timeout | undefined
  private log: FastifyBaseLogger | undefined

  constructor(private readonly options: GatewayOptions) {}

  /** The server's logger, once register() ran. */
  get logger(): FastifyBaseLogger | undefined {
    return this.log
  }

  get leaseTtlMs(): number {
    return this.options.leaseTtlMs ?? this.options.heartbeatMs * 4
  }

  /** Adds the WebSocket route (auth by agent token, not by user session). */
  register(app: FastifyInstance): void {
    this.log = app.log
    // The websocket plugin itself is registered once by buildServer (shared with /ws/ui).
    void app.register(async (instance) => {
      instance.get(
        '/ws/agent',
        { websocket: true, config: { public: true } },
        (socket, request) => {
          this.accept(socket, request.headers.authorization)
        },
      )
    })
    app.addHook('onClose', async () => this.stop())
    this.start()
  }

  on<T extends MessageType>(type: T, handler: MessageHandler<T>): void {
    this.handlers.set(type, (ctx, message) =>
      handler(ctx, message as Extract<Message, { type: T }>),
    )
  }

  /** Called once per agent whose connection is gone (closed, timed out or revoked). */
  onAgentOffline(listener: (agent: AgentRef) => Promise<void> | void): void {
    this.offlineListeners.push(listener)
  }

  isOnline(agentId: string): boolean {
    return this.connections.get(agentId)?.hello === true
  }

  /** Sends a server message to an agent; false when it is not connected. */
  send<T extends MessageType>(agentId: string, type: T, payload: Payload<T>, re?: string): boolean {
    const connection = this.connections.get(agentId)
    if (!connection?.hello || connection.socket.readyState !== connection.socket.OPEN) return false
    connection.socket.send(JSON.stringify(protocol.envelope(type, payload, re)))
    return true
  }

  disconnect(agentId: string, code: number, reason: string): void {
    this.connections.get(agentId)?.socket.close(code, reason)
  }

  start(): void {
    if (this.timer) return
    const every = Math.max(50, Math.floor(this.options.heartbeatMs / 2))
    this.timer = setInterval(() => this.checkHeartbeats(), every)
    this.timer.unref()
  }

  /** Closes every connection and marks the agents offline before the DB goes away. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    const open = [...this.connections.values()]
    this.connections.clear()
    for (const connection of open) {
      connection.socket.close(CLOSE.shutdown, 'server shutting down')
      await connection.queue.catch(() => undefined)
      await connection.session.offline().catch(() => undefined)
    }
  }

  private checkHeartbeats(): void {
    const deadline = Date.now() - this.options.heartbeatMs * MISSED_HEARTBEATS
    for (const connection of this.connections.values()) {
      if (connection.lastSeen < deadline) {
        this.log?.warn({ agent: connection.agent.id }, 'agent missed heartbeats')
        connection.socket.close(CLOSE.heartbeatTimeout, 'heartbeat timeout')
        // A peer that stopped reading never completes the close handshake.
        setTimeout(() => connection.socket.terminate(), 1000).unref()
      }
    }
  }

  private accept(socket: WebSocket, authorization: string | undefined): void {
    // Listen before the (async) token lookup: an agent sends hello as soon as the socket opens,
    // and ws does not buffer messages for late listeners. Everything waits behind `auth`.
    let connection: Connection | undefined
    let queue: Promise<void> = this.authenticate(socket, authorization).then((c) => {
      connection = c
    })
    const enqueue = (task: (c: Connection) => Promise<void>) => {
      queue = queue
        .then(() => (connection ? task(connection) : undefined))
        .catch((error: unknown) =>
          this.log?.error({ err: error, agent: connection?.agent.id }, 'agent message failed'),
        )
      if (connection) connection.queue = queue
    }
    socket.on('message', (data, isBinary) => {
      const raw = isBinary ? '' : Buffer.from(data as Buffer).toString('utf8')
      // One message at a time per agent: step results must be stored in order.
      enqueue(async (c) => {
        c.lastSeen = Date.now()
        await this.handle(c, raw)
      })
    })
    socket.on('close', () => enqueue((c) => this.closed(c)))
  }

  private async authenticate(
    socket: WebSocket,
    authorization: string | undefined,
  ): Promise<Connection | undefined> {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined
    const row = token ? await findAgentByToken(this.options.db, token) : undefined
    if (!row) {
      socket.close(CLOSE.unauthorized, 'invalid or revoked agent token')
      return undefined
    }
    const agent = { id: row.id, tenantId: row.tenantId, name: row.name }
    const previous = this.connections.get(agent.id)
    const connection: Connection = {
      agent,
      socket,
      session: agentSessionRepo(this.options.db, agent),
      lastSeen: Date.now(),
      hello: false,
      invalidAt: [],
      queue: Promise.resolve(),
    }
    this.connections.set(agent.id, connection)
    previous?.socket.close(CLOSE.replaced, 'replaced by a new connection')
    return connection
  }

  private async closed(connection: Connection): Promise<void> {
    if (this.connections.get(connection.agent.id) !== connection) return
    this.connections.delete(connection.agent.id)
    await connection.session.offline()
    for (const listener of this.offlineListeners) await listener(connection.agent)
  }

  private sendRaw(connection: Connection, type: MessageType, payload: unknown, re?: string): void {
    if (connection.socket.readyState !== connection.socket.OPEN) return
    connection.socket.send(JSON.stringify(protocol.envelope(type, payload, re)))
  }

  private invalid(connection: Connection, message: string, re?: string): void {
    this.sendRaw(connection, 'error', { code: 'invalid_message', message }, re)
    const now = Date.now()
    connection.invalidAt = [...connection.invalidAt.filter((t) => now - t < 60_000), now]
    if (connection.invalidAt.length > MAX_INVALID_PER_MINUTE) {
      connection.socket.close(CLOSE.tooManyInvalid, 'too many invalid messages')
    }
  }

  private async handle(connection: Connection, raw: string): Promise<void> {
    const parsed = protocol.parseMessage(raw)
    if (!parsed.ok) {
      this.log?.warn({ agent: connection.agent.id, code: parsed.code }, parsed.message)
      this.invalid(connection, parsed.message, parsed.id)
      return
    }
    const message = parsed.message
    if (protocol.MESSAGE_DIRECTION[message.type] === 'S→A') {
      this.invalid(connection, `${message.type} is sent by the server, not by agents`, message.id)
      return
    }
    const ctx: AgentContext = {
      agent: connection.agent,
      session: connection.session,
      reply: (type, payload) => this.sendRaw(connection, type, payload, message.id),
    }
    if (message.type === 'agent.hello') {
      await connection.session.hello({
        os: message.payload.os,
        version: message.payload.agent_version,
        capabilities: message.payload.capabilities,
        devices: message.payload.devices,
        now: new Date(),
      })
      connection.hello = true
      ctx.reply('agent.welcome', {
        agent_id: connection.agent.id,
        heartbeat_ms: this.options.heartbeatMs,
      })
      return
    }
    if (!connection.hello) {
      this.sendRaw(
        connection,
        'error',
        { code: 'hello_required', message: 'send agent.hello first' },
        message.id,
      )
      return
    }
    switch (message.type) {
      case 'agent.heartbeat':
        await connection.session.heartbeat(new Date(), this.leaseTtlMs)
        break
      case 'device.update':
        await connection.session.updateDevices({ ...message.payload, now: new Date() })
        break
      case 'error':
        this.log?.warn(
          { agent: connection.agent.id, error: message.payload },
          'agent reported an error',
        )
        break
      default: {
        const handler = this.handlers.get(message.type)
        if (handler) await handler(ctx, message)
        else this.log?.warn({ type: message.type }, 'no handler for agent message')
      }
    }
  }
}
