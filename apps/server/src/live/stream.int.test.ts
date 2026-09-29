import type { Socket } from 'node:net'
import { protocol } from '@coral/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { devices } from '../db/schema'
import { fakeAgent } from '../testing/fake-agent'
import { startRunServer, type RunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'
import { connectUi, type UiClient } from '../testing/ui-client'
import { emulator } from '../testing/ws-client'

let server: RunServer
let huynh: TestUser
let agent: Awaited<ReturnType<typeof fakeAgent>>
let deviceId = ''
const tabs: UiClient[] = []

beforeAll(async () => {
  server = await startRunServer()
  huynh = await server.newUser('Huynh')
  const fixture = await server.seed(huynh)
  agent = await fakeAgent(server.url, fixture.agent.token, { devices: [emulator('d1')] })
  const [row] = await server.db.select().from(devices).where(eq(devices.agentId, fixture.agent.id))
  deviceId = row?.id ?? ''
})
afterAll(async () => {
  for (const tab of tabs) tab.close()
  agent.close()
  await server.close()
})

async function tab(user: TestUser) {
  const client = await connectUi(server.url)
  tabs.push(client)
  await client.auth(user.token)
  return client
}

/** A frame as the agent sends it: by udid, with `size` bytes of image. */
function agentFrame(seq: number, size = 16) {
  const image = new Uint8Array(size)
  image.set([0xff, 0xd8, seq % 256])
  return protocol.encodeFrame(
    {
      type: 'stream.frame',
      udid: 'd1',
      seq,
      ts: Date.now(),
      width: 576,
      height: 1280,
      device_width: 1080,
      device_height: 2400,
      rotation: 0,
      mime: 'image/jpeg',
    },
    image,
  )
}

const sendFrame = (seq: number, size?: number) =>
  new Promise<void>((resolve, reject) =>
    agent.client.ws.send(agentFrame(seq, size), { binary: true }, (e) =>
      e ? reject(e) : resolve(),
    ),
  )

const decode = (bytes: Uint8Array) => {
  const decoded = protocol.decodeFrame(bytes)
  if (!decoded.ok) throw new Error(decoded.message)
  return decoded.frame
}

const until = async (check: () => boolean, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('live view through the server (T029)', () => {
  it('starts the agent stream once, fans frames out to two tabs, stops after the last', async () => {
    const one = await tab(huynh)
    const two = await tab(huynh)
    one.send('stream.subscribe', { device_id: deviceId })
    two.send('stream.subscribe', { device_id: deviceId })
    expect((await one.next('stream.status')).payload).toEqual({
      device_id: deviceId,
      state: 'starting',
    })
    const start = await agent.client.next('stream.start')
    expect(start.payload).toEqual({ udid: 'd1', fps: 4, max_edge: 1280, quality: 60 })
    await until(() => server.streams.viewersOf(deviceId).length === 2)

    for (let seq = 0; seq < 3; seq += 1) await sendFrame(seq)
    for (const client of [one, two]) {
      const frames = [
        await client.nextBinary(),
        await client.nextBinary(),
        await client.nextBinary(),
      ]
      expect(frames.map((f) => decode(f).header.seq)).toEqual([0, 1, 2])
      expect(decode(frames[0] ?? new Uint8Array()).header).toMatchObject({
        device_id: deviceId,
        width: 576,
        device_width: 1080,
      })
      expect(decode(frames[0] ?? new Uint8Array()).header.udid).toBeUndefined()
    }
    expect((await two.next('stream.status')).payload).toMatchObject({ state: 'starting' })
    expect((await two.next('stream.status')).payload).toMatchObject({ state: 'live' })
    // Only one stream.start for two viewers.
    expect(agent.client.received.filter((m) => m.type === 'stream.start')).toEqual([])

    one.send('stream.unsubscribe', { device_id: deviceId })
    await new Promise((r) => setTimeout(r, 100))
    expect(agent.client.received.filter((m) => m.type === 'stream.stop')).toEqual([])
    two.close()
    expect((await agent.client.next('stream.stop')).payload).toEqual({ udid: 'd1' })
  })

  it("refuses another tenant's tab", async () => {
    const outsider = await tab(await server.newUser('Other'))
    const request = outsider.send('stream.subscribe', { device_id: deviceId })
    expect((await outsider.next('error', request.id)).payload).toMatchObject({ code: 'not_found' })
  })

  it('drops frames for a tab that does not read, not for the others', async () => {
    const fast = await tab(huynh)
    const slow = await tab(huynh)
    fast.send('stream.subscribe', { device_id: deviceId })
    slow.send('stream.subscribe', { device_id: deviceId })
    await agent.client.next('stream.start')
    await until(() => server.streams.viewersOf(deviceId).length === 2)
    // The slow tab stops reading its socket: the server's send buffer for it fills up.
    ;(slow.ws as unknown as { _socket: Socket })._socket.pause()
    const total = 60
    // Paced like a real stream: the next frame goes once the fast tab has the previous one.
    for (let seq = 0; seq < total; seq += 1) {
      await sendFrame(seq, 256 * 1024)
      await until(() => fast.binaries.length > seq)
    }
    ;(slow.ws as unknown as { _socket: Socket })._socket.resume()
    await new Promise((r) => setTimeout(r, 500))
    const slowFrames = slow.binaries.length
    console.log(`slow tab got ${slowFrames} of ${total} frames, fast tab ${fast.binaries.length}`)
    expect(fast.binaries.length).toBe(total)
    expect(slowFrames).toBeLessThan(total)
    expect(slowFrames).toBeGreaterThan(0)
  }, 30_000)
})
