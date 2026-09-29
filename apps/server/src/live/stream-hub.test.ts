import { newId, protocol } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import type { AgentRef } from '../agents/gateway'
import type { UiConnection, UiContext } from '../ui/gateway'
import { MAX_VIEWER_BUFFER, STALL_MS, StreamHub, type StreamDevice } from './stream-hub'

const TENANT = newId()
const agent: AgentRef = { id: newId(), tenantId: TENANT, name: 'laptop' }
const pixel: StreamDevice = {
  id: newId(),
  tenantId: TENANT,
  agentId: agent.id,
  udid: 'emulator-5554',
  online: true,
}

type Handler = (ctx: UiContext, message: { payload: unknown }) => Promise<void> | void

/** The hub between a fake UI gateway and a fake agent gateway; the test plays both sides. */
function setup(devices: StreamDevice[] = [pixel]) {
  let time = 1_000_000
  const handlers = new Map<string, Handler>()
  const closeListeners: ((c: UiConnection) => Promise<void> | void)[] = []
  const toViewers: { connectionId: string; type: string; payload: unknown }[] = []
  const binaries = new Map<string, Uint8Array[]>()
  const full = new Set<string>()
  const toAgents: { agentId: string; type: string; payload: unknown }[] = []
  const agentListeners = {
    binary: [] as ((a: AgentRef, b: Uint8Array) => void)[],
    online: [] as ((a: AgentRef) => void)[],
    offline: [] as ((a: AgentRef) => void | Promise<void>)[],
  }
  let agentOnline = true
  const hub = new StreamHub({
    now: () => time,
    checkEveryMs: 0,
    findDevice: (tenantId, deviceId) =>
      Promise.resolve(devices.find((d) => d.id === deviceId && d.tenantId === tenantId)),
    ui: {
      on: (type, handler) => handlers.set(type, handler as unknown as Handler),
      onClose: (listener) => closeListeners.push(listener),
      sendTo: (connectionId, type, payload) => {
        toViewers.push({ connectionId, type, payload })
        return true
      },
      sendBinary: (connectionId, bytes, maxBuffered) => {
        expect(maxBuffered).toBe(MAX_VIEWER_BUFFER)
        if (full.has(connectionId)) return false
        binaries.set(connectionId, [...(binaries.get(connectionId) ?? []), bytes])
        return true
      },
    },
    agents: {
      send: (agentId, type, payload) => {
        toAgents.push({ agentId, type, payload })
        return agentOnline
      },
      onBinary: (l) => agentListeners.binary.push(l),
      onAgentOnline: (l) => agentListeners.online.push(l),
      onAgentOffline: (l) => agentListeners.offline.push(l),
    },
  })

  async function call(
    type: 'stream.subscribe' | 'stream.unsubscribe',
    connectionId: string,
    deviceId: string,
    tenantId = TENANT,
  ) {
    const errors: { code: string; message: string }[] = []
    const ctx: UiContext = {
      connection: { id: connectionId, user: { userId: newId(), tenantId, role: 'viewer' } },
      reply: () => undefined,
      fail: (code, message) => void errors.push({ code, message }),
    }
    await handlers.get(type)?.(ctx, { payload: { device_id: deviceId } })
    return errors
  }

  const frame = (from: AgentRef, udid: string, seq: number) =>
    protocol.encodeFrame(
      {
        type: 'stream.frame',
        udid,
        seq,
        ts: time,
        width: 576,
        height: 1280,
        device_width: 1080,
        device_height: 2400,
        rotation: 0,
        mime: 'image/jpeg',
      },
      Uint8Array.from([0xff, 0xd8, seq]),
    )
  const sendFrame = (from: AgentRef, udid: string, seq: number) => {
    for (const l of agentListeners.binary) l(from, frame(from, udid, seq))
  }
  const statuses = (connectionId: string) =>
    toViewers
      .filter((m) => m.connectionId === connectionId && m.type === 'stream.status')
      .map((m) => (m.payload as { state: string }).state)
  const received = (connectionId: string) =>
    (binaries.get(connectionId) ?? []).map((bytes) => {
      const decoded = protocol.decodeFrame(bytes)
      if (!decoded.ok) throw new Error(decoded.message)
      return decoded.frame
    })

  return {
    hub,
    call,
    sendFrame,
    statuses,
    received,
    toAgents,
    full,
    agentListeners,
    closeListeners,
    advance: (ms: number) => (time += ms),
    setAgentOnline: (online: boolean) => (agentOnline = online),
  }
}

describe('StreamHub (US2, research R4–R5)', () => {
  it('starts the stream for the first viewer and stops it after the last one', async () => {
    const t = setup()
    expect(await t.call('stream.subscribe', 'tab-1', pixel.id)).toEqual([])
    await t.call('stream.subscribe', 'tab-2', pixel.id)
    expect(t.toAgents).toEqual([
      {
        agentId: agent.id,
        type: 'stream.start',
        payload: { udid: 'emulator-5554', fps: 4, max_edge: 1280, quality: 60 },
      },
    ])
    expect(t.statuses('tab-1')).toEqual(['starting'])
    await t.call('stream.unsubscribe', 'tab-1', pixel.id)
    expect(t.toAgents).toHaveLength(1)
    // A closed tab counts as unsubscribed.
    for (const l of t.closeListeners)
      await l({ id: 'tab-2', user: { userId: newId(), tenantId: TENANT, role: 'owner' } })
    expect(t.toAgents.at(-1)).toEqual({
      agentId: agent.id,
      type: 'stream.stop',
      payload: { udid: 'emulator-5554' },
    })
    expect(t.hub.viewersOf(pixel.id)).toEqual([])
  })

  it('fans frames out to every viewer with the device id instead of the udid', async () => {
    const t = setup()
    await t.call('stream.subscribe', 'tab-1', pixel.id)
    await t.call('stream.subscribe', 'tab-2', pixel.id)
    t.sendFrame(agent, 'emulator-5554', 0)
    t.sendFrame(agent, 'emulator-5554', 1)
    for (const tab of ['tab-1', 'tab-2']) {
      const frames = t.received(tab)
      expect(frames.map((f) => f.header.seq)).toEqual([0, 1])
      expect(frames[0]?.header).toMatchObject({
        device_id: pixel.id,
        width: 576,
        mime: 'image/jpeg',
      })
      expect(frames[0]?.header.udid).toBeUndefined()
      expect([...(frames[1]?.image ?? [])]).toEqual([0xff, 0xd8, 1])
    }
    expect(t.statuses('tab-1')).toEqual(['starting', 'live'])
  })

  it('drops frames for a viewer that is behind, not for the others', async () => {
    const t = setup()
    await t.call('stream.subscribe', 'slow', pixel.id)
    await t.call('stream.subscribe', 'fast', pixel.id)
    t.full.add('slow')
    t.sendFrame(agent, 'emulator-5554', 0)
    t.sendFrame(agent, 'emulator-5554', 1)
    t.full.delete('slow')
    t.sendFrame(agent, 'emulator-5554', 2)
    expect(t.received('fast').map((f) => f.header.seq)).toEqual([0, 1, 2])
    expect(t.received('slow').map((f) => f.header.seq)).toEqual([2])
  })

  it("refuses another tenant's device and an offline one; ignores frames nobody asked for", async () => {
    const offline = { ...pixel, id: newId(), udid: 'emulator-5556', online: false }
    const t = setup([pixel, offline])
    expect(await t.call('stream.subscribe', 'tab-x', pixel.id, newId())).toMatchObject([
      { code: 'not_found' },
    ])
    expect(await t.call('stream.subscribe', 'tab-1', offline.id)).toMatchObject([
      { code: 'device_offline' },
    ])
    expect(t.toAgents).toEqual([])
    await t.call('stream.subscribe', 'tab-1', pixel.id)
    // Another agent claiming the same udid, and a udid nobody watches: dropped.
    t.sendFrame({ ...agent, id: newId() }, 'emulator-5554', 0)
    t.sendFrame(agent, 'emulator-5556', 0)
    expect(t.received('tab-1')).toEqual([])
  })

  it('reports stalled after 5 s without a frame, live again when frames resume', async () => {
    const t = setup()
    await t.call('stream.subscribe', 'tab-1', pixel.id)
    t.sendFrame(agent, 'emulator-5554', 0)
    t.advance(STALL_MS)
    t.hub.checkStalls()
    expect(t.statuses('tab-1')).toEqual(['starting', 'live'])
    t.advance(1)
    t.hub.checkStalls()
    t.hub.checkStalls()
    expect(t.statuses('tab-1')).toEqual(['starting', 'live', 'stalled'])
    t.sendFrame(agent, 'emulator-5554', 1)
    expect(t.statuses('tab-1').at(-1)).toBe('live')
  })

  it('reports stopped when the agent goes, and starts again when it is back', async () => {
    const t = setup()
    await t.call('stream.subscribe', 'tab-1', pixel.id)
    for (const l of t.agentListeners.offline) await l(agent)
    expect(t.statuses('tab-1').at(-1)).toBe('stopped')
    for (const l of t.agentListeners.online) l(agent)
    expect(t.statuses('tab-1').at(-1)).toBe('starting')
    expect(t.toAgents.filter((m) => m.type === 'stream.start')).toHaveLength(2)
  })

  it('says stopped at once when the agent cannot be reached', async () => {
    const t = setup()
    t.setAgentOnline(false)
    await t.call('stream.subscribe', 'tab-1', pixel.id)
    expect(t.statuses('tab-1')).toEqual(['stopped'])
  })
})
