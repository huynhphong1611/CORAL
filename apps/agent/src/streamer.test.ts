import { protocol } from '@coral/shared'
import { realClock, type DeviceDriver } from '@coral/runner'
import { FakeClock, FakeDriver, sampleApp } from '@coral/runner/testing'
import { describe, expect, it } from 'vitest'
import { FAILURE_PAUSE_MS, MAX_FRAME_FAILURES, Streamer } from './streamer'

const START = { udid: 'emulator-5554', fps: 4, max_edge: 1280, quality: 60 }

/** A streamer on a drawn fake device; `send` decides what writing a frame costs. */
function setup(
  opts: {
    clock?: FakeClock | typeof realClock
    driver?: DeviceDriver & { streamFrame?: FakeDriver['streamFrame'] }
    captureMs?: number
    sendMs?: number
    connected?: () => boolean
    stopAfter?: number
  } = {},
) {
  const clock = opts.clock ?? new FakeClock(1_000)
  const fake = new FakeDriver({ ...sampleApp(), renderScreens: { scale: 0.5 } })
  const driver =
    opts.driver ??
    Object.assign(fake, {
      streamFrame: async (options: Parameters<FakeDriver['streamFrame']>[0]) => {
        if (clock instanceof FakeClock) clock.time += opts.captureMs ?? 50
        return FakeDriver.prototype.streamFrame.call(fake, options)
      },
    })
  const frames: protocol.Frame[] = []
  const counts = { acquired: 0, released: 0, inFlight: 0, maxInFlight: 0 }
  const holder: { streamer?: Streamer } = {}
  const streamer = new Streamer({
    clock,
    sessions: {
      acquire: () => {
        counts.acquired += 1
        return Promise.resolve({
          driver,
          release: () => {
            counts.released += 1
            return Promise.resolve()
          },
        })
      },
    },
    send: async (bytes) => {
      counts.inFlight += 1
      counts.maxInFlight = Math.max(counts.maxInFlight, counts.inFlight)
      if (clock instanceof FakeClock) clock.time += opts.sendMs ?? 10
      await Promise.resolve()
      counts.inFlight -= 1
      if (!(opts.connected?.() ?? true)) return false
      const decoded = protocol.decodeFrame(bytes)
      if (!decoded.ok) throw new Error(decoded.message)
      frames.push(decoded.frame)
      if (opts.stopAfter !== undefined && frames.length === opts.stopAfter) {
        void holder.streamer?.stop(START.udid)
      }
      return true
    },
  })
  holder.streamer = streamer
  const stopped = () =>
    new Promise<void>((resolve) => {
      const check = () => (streamer.active.length === 0 ? resolve() : setTimeout(check, 1))
      check()
    })
  return { streamer, clock, frames, counts, stopped }
}

describe('Streamer (research R4)', () => {
  it('sends frames at the requested fps: capture + send, then sleeps the rest of the period', async () => {
    const { streamer, clock, frames, counts, stopped } = setup({ stopAfter: 5 })
    streamer.start(START)
    await stopped()
    expect(frames.map((f) => f.header.seq)).toEqual([0, 1, 2, 3, 4])
    expect(frames[0]?.header).toMatchObject({
      type: 'stream.frame',
      udid: START.udid,
      mime: 'image/png',
      width: 540,
      height: 1200,
      device_width: 1080,
      device_height: 2400,
      rotation: 0,
    })
    expect(protocol.frameHeaderSchema.safeParse(frames[0]?.header).success).toBe(true)
    // 250 ms per frame at 4 fps; capture took 50 and sending 10.
    expect((clock as FakeClock).sleeps.slice(0, 4)).toEqual([190, 190, 190, 190])
    expect(counts).toMatchObject({ acquired: 1, released: 1 })
  })

  it('never queues: one frame in flight, and a slow link just lowers the frame rate', async () => {
    const { streamer, clock, counts, frames, stopped } = setup({ sendMs: 400, stopAfter: 4 })
    streamer.start(START)
    await stopped()
    expect(frames).toHaveLength(4)
    expect(counts.maxInFlight).toBe(1)
    // Each frame took longer than the period: no sleep, no burst to catch up.
    expect((clock as FakeClock).sleeps).toEqual([])
  })

  it('changes fps in place when started again, without a second loop', async () => {
    const { streamer, clock, counts, stopped } = setup({ stopAfter: 6 })
    streamer.start(START)
    streamer.start({ ...START, fps: 2 })
    await stopped()
    expect(counts.acquired).toBe(1)
    // 500 ms per frame at 2 fps.
    expect((clock as FakeClock).sleeps[0]).toBe(440)
  })

  it('stops cleanly: wakes from the sleep, gives the session back, sends nothing more', async () => {
    const { streamer, frames, counts } = setup({ clock: realClock })
    streamer.start({ ...START, fps: 2 })
    while (frames.length === 0) await new Promise((r) => setTimeout(r, 5))
    const before = Date.now()
    await streamer.stop(START.udid)
    expect(Date.now() - before).toBeLessThan(200)
    expect(counts.released).toBe(1)
    const sent = frames.length
    await new Promise((r) => setTimeout(r, 600))
    expect(frames.length).toBe(sent)
    expect(streamer.active).toEqual([])
  })

  it('gives up after repeated capture failures, pausing between them', async () => {
    const failing = new FakeDriver({ ...sampleApp() })
    const driver = Object.assign(failing, {
      streamFrame: () => Promise.reject(new Error('device offline')),
    })
    const { streamer, clock, counts, frames, stopped } = setup({ driver })
    streamer.start(START)
    await stopped()
    expect(frames).toEqual([])
    expect((clock as FakeClock).sleeps).toEqual(
      Array.from({ length: MAX_FRAME_FAILURES - 1 }, () => FAILURE_PAUSE_MS),
    )
    expect(counts.released).toBe(1)
  })

  it('stops when the connection is gone (the server restarts it after the next hello)', async () => {
    const { streamer, counts, stopped } = setup({ connected: () => false })
    streamer.start(START)
    await stopped()
    expect(counts.released).toBe(1)
  })

  it('sends the PNG screenshot from drivers that cannot stream', async () => {
    const plain = new FakeDriver({ ...sampleApp(), renderScreens: { scale: 0.5 } })
    const driver = Object.assign(plain, { streamFrame: undefined })
    const { streamer, frames, stopped } = setup({ driver, stopAfter: 1 })
    streamer.start(START)
    await stopped()
    expect(frames[0]?.header).toMatchObject({ mime: 'image/png', width: 540, device_width: 1080 })
  })
})
