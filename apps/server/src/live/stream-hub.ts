import { protocol } from '@coral/shared'
import type { FastifyBaseLogger } from 'fastify'
import type { AgentGateway, AgentRef } from '../agents/gateway'
import type { Db } from '../db/client'
import { HttpError } from '../http/errors'
import { agentsRepo } from '../repos/agents'
import type { UiGateway } from '../ui/gateway'

type StreamStatus = protocol.UiPayload<'stream.status'>

/** No frame for this long while someone watches → `stalled` (contracts/ui-ws.md). */
export const STALL_MS = 5000
/** A viewer with more than this queued gets no new frame until it catches up (research R5). */
export const MAX_VIEWER_BUFFER = 1024 * 1024
/** Live-view parameters asked from agents (contracts/agent-ws-phase2.md defaults). */
export const STREAM_PARAMS = { fps: 4, max_edge: 1280, quality: 60 } as const

/** What the hub needs to know about a device a viewer asks for. */
export interface StreamDevice {
  id: string
  tenantId: string
  agentId: string
  udid: string
  online: boolean
}

export interface StreamHubOptions {
  ui: Pick<UiGateway, 'on' | 'onClose' | 'sendTo' | 'sendBinary'>
  agents: Pick<AgentGateway, 'send' | 'onBinary' | 'onAgentOnline' | 'onAgentOffline'>
  /** The device in the caller's tenant; undefined when it does not exist there. */
  findDevice(tenantId: string, deviceId: string): Promise<StreamDevice | undefined>
  /** How often stalls are looked for (default 1 s; 0 = never, tests call checkStalls). */
  checkEveryMs?: number
  now?: () => number
  log?: FastifyBaseLogger
}

interface Watched {
  device: StreamDevice
  viewers: Set<string>
  state: StreamStatus['state']
  lastFrameAt: number
  frames: number
}

const agentKey = (agentId: string, udid: string) => `${agentId}\u0000${udid}`

/**
 * Live view fan-out (US2, research R4–R5): browsers subscribe to a device of their tenant; the
 * first viewer starts the agent's stream, the last one stops it. Frames from the agent (by udid)
 * go out to the viewers with the device id instead; a viewer that cannot keep up misses frames,
 * the others do not wait for it.
 */
export class StreamHub {
  private readonly watched = new Map<string, Watched>()
  private readonly byAgent = new Map<string, string>()
  private readonly timer: NodeJS.Timeout | undefined
  private readonly now: () => number

  constructor(private readonly options: StreamHubOptions) {
    this.now = options.now ?? Date.now
    const { ui, agents } = options
    ui.on('stream.subscribe', async (ctx, message) => {
      const { device_id: deviceId } = message.payload
      const device = await options.findDevice(ctx.connection.user.tenantId, deviceId)
      if (!device) {
        ctx.fail('not_found', 'device not found')
        return
      }
      if (!device.online) {
        ctx.fail('device_offline', 'the device is offline')
        return
      }
      this.subscribe(ctx.connection.id, device)
    })
    ui.on('stream.unsubscribe', (ctx, message) => {
      this.unsubscribe(ctx.connection.id, message.payload.device_id)
    })
    ui.onClose((connection) => {
      for (const [deviceId, watched] of this.watched) {
        if (watched.viewers.has(connection.id)) this.unsubscribe(connection.id, deviceId)
      }
    })
    agents.onBinary((agent, bytes) => this.frame(agent, bytes))
    agents.onAgentOnline((agent) => this.agentOnline(agent))
    agents.onAgentOffline((agent) => this.agentOffline(agent))
    const every = options.checkEveryMs ?? 1000
    if (every > 0) {
      this.timer = setInterval(() => this.checkStalls(), every)
      this.timer.unref()
    }
  }

  /** Viewers of a device (tests, metrics). */
  viewersOf(deviceId: string): string[] {
    return [...(this.watched.get(deviceId)?.viewers ?? [])]
  }

  /** Marks streams without a frame for {@link STALL_MS} as `stalled`. */
  checkStalls(now = this.now()): void {
    for (const watched of this.watched.values()) {
      const quiet = now - watched.lastFrameAt > STALL_MS
      if (quiet && (watched.state === 'live' || watched.state === 'starting')) {
        this.setState(watched, 'stalled', 'no frame for 5 s')
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  /** The server's logger, once the app exists. */
  attachLogger(log: FastifyBaseLogger): void {
    this.options.log = log
  }

  private subscribe(connectionId: string, device: StreamDevice): void {
    const existing = this.watched.get(device.id)
    if (!existing) {
      const watched: Watched = {
        device,
        viewers: new Set([connectionId]),
        state: 'starting',
        lastFrameAt: this.now(),
        frames: 0,
      }
      this.watched.set(device.id, watched)
      this.byAgent.set(agentKey(device.agentId, device.udid), device.id)
      if (!this.startOnAgent(watched)) watched.state = 'stopped'
      this.options.ui.sendTo(connectionId, 'stream.status', this.status(watched))
      return
    }
    existing.viewers.add(connectionId)
    // Stopped when the agent was gone, and online again by now: start over, for everyone.
    if (existing.state === 'stopped') this.restart(existing)
    else this.options.ui.sendTo(connectionId, 'stream.status', this.status(existing))
  }

  private unsubscribe(connectionId: string, deviceId: string): void {
    const watched = this.watched.get(deviceId)
    if (!watched?.viewers.delete(connectionId) || watched.viewers.size > 0) return
    this.watched.delete(deviceId)
    this.byAgent.delete(agentKey(watched.device.agentId, watched.device.udid))
    this.options.agents.send(watched.device.agentId, 'stream.stop', { udid: watched.device.udid })
  }

  /** Asks the agent for frames; false when it is not connected. */
  private startOnAgent(watched: Watched): boolean {
    watched.lastFrameAt = this.now()
    return this.options.agents.send(watched.device.agentId, 'stream.start', {
      udid: watched.device.udid,
      ...STREAM_PARAMS,
    })
  }

  private restart(watched: Watched): void {
    if (this.startOnAgent(watched)) this.setState(watched, 'starting')
    else this.setState(watched, 'stopped', 'agent offline')
  }

  private frame(agent: AgentRef, bytes: Uint8Array): void {
    const decoded = protocol.decodeFrame(bytes)
    if (!decoded.ok || decoded.frame.header.udid === undefined) {
      this.options.log?.warn({ agent: agent.id }, 'invalid live-view frame from agent')
      return
    }
    const { header, image } = decoded.frame
    const udid = header.udid ?? ''
    // Only devices of this very agent that someone watches (P5): anything else is dropped.
    const deviceId = this.byAgent.get(agentKey(agent.id, udid))
    const watched = deviceId ? this.watched.get(deviceId) : undefined
    if (!watched || watched.device.tenantId !== agent.tenantId) return
    watched.lastFrameAt = this.now()
    watched.frames += 1
    if (watched.state !== 'live') this.setState(watched, 'live')
    const out = protocol.encodeFrame(
      {
        type: 'stream.frame',
        device_id: watched.device.id,
        seq: header.seq,
        ts: header.ts,
        width: header.width,
        height: header.height,
        device_width: header.device_width,
        device_height: header.device_height,
        rotation: header.rotation,
        mime: header.mime,
      },
      image,
    )
    for (const viewer of watched.viewers) {
      this.options.ui.sendBinary(viewer, out, MAX_VIEWER_BUFFER)
    }
  }

  /** An agent (re)connected: streams its viewers still wait for start again. */
  private agentOnline(agent: AgentRef): void {
    for (const watched of this.watched.values()) {
      if (watched.device.agentId === agent.id) this.restart(watched)
    }
  }

  private agentOffline(agent: AgentRef): void {
    for (const watched of this.watched.values()) {
      if (watched.device.agentId === agent.id) this.setState(watched, 'stopped', 'agent offline')
    }
  }

  private setState(watched: Watched, state: StreamStatus['state'], reason?: string): void {
    watched.state = state
    const status = this.status(watched, reason)
    for (const viewer of watched.viewers) this.options.ui.sendTo(viewer, 'stream.status', status)
  }

  private status(watched: Watched, reason?: string): StreamStatus {
    return { device_id: watched.device.id, state: watched.state, ...(reason ? { reason } : {}) }
  }
}

/** Looks devices up in the caller's tenant; online = not offline and its agent connected. */
export function deviceLookup(
  db: Db,
  agents: Pick<AgentGateway, 'isOnline'>,
): StreamHubOptions['findDevice'] {
  return async (tenantId, deviceId) => {
    try {
      const row = await agentsRepo(db, tenantId).getDevice(deviceId)
      return {
        id: row.id,
        tenantId,
        agentId: row.agentId,
        udid: row.udid,
        online: row.status !== 'offline' && agents.isOnline(row.agentId),
      }
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return undefined
      throw error
    }
  }
}
