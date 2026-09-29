import { protocol } from '@coral/shared'
import {
  AbortError,
  imageInfo,
  realClock,
  type Clock,
  type DeviceDriver,
  type FrameSource,
  type LiveFrame,
} from '@coral/runner'
import type { Logger } from 'pino'
import type { DeviceSessions } from './device-sessions'

type StreamStart = protocol.Payload<'stream.start'>

/** Consecutive capture failures after which a stream gives up (the device is likely gone). */
export const MAX_FRAME_FAILURES = 5
/** Pause after a failed capture before trying again. */
export const FAILURE_PAUSE_MS = 1000

export interface StreamerOptions {
  sessions: Pick<DeviceSessions, 'acquire'>
  /** Sends one encoded frame; resolves once written, false when not connected. */
  send(frame: Uint8Array): Promise<boolean>
  clock?: Clock
  log?: Pick<Logger, 'info' | 'warn' | 'debug'>
}

interface Stream {
  params: StreamStart
  seq: number
  abort: AbortController
  done: Promise<void>
}

/**
 * Live view on the agent (research R4, contracts/agent-ws-phase2.md): per device, one frame at a
 * time — capture, send, wait until it is written, then sleep what is left of the 1/fps period —
 * so a slow link lowers the frame rate instead of queueing stale frames. Reads only: it runs next
 * to a job on the same device session.
 */
export class Streamer {
  private readonly streams = new Map<string, Stream>()
  private readonly clock: Clock

  constructor(private readonly options: StreamerOptions) {
    this.clock = options.clock ?? realClock
  }

  /** Streaming devices. */
  get active(): string[] {
    return [...this.streams.keys()]
  }

  /** Starts streaming a device; for a device already streaming, only the parameters change. */
  start(params: StreamStart): void {
    const current = this.streams.get(params.udid)
    if (current) {
      current.params = params
      return
    }
    const stream: Stream = {
      params,
      seq: 0,
      abort: new AbortController(),
      done: Promise.resolve(),
    }
    this.streams.set(params.udid, stream)
    stream.done = this.run(stream).finally(() => {
      if (this.streams.get(params.udid) === stream) this.streams.delete(params.udid)
    })
  }

  /** Stops a device's stream and waits until its session is given back. */
  async stop(udid: string): Promise<void> {
    const stream = this.streams.get(udid)
    if (!stream) return
    this.streams.delete(udid)
    stream.abort.abort()
    await stream.done
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.active.map((udid) => this.stop(udid)))
  }

  private async run(stream: Stream): Promise<void> {
    const { udid } = stream.params
    const { signal } = stream.abort
    const log = this.options.log
    let lease: Awaited<ReturnType<StreamerOptions['sessions']['acquire']>>
    try {
      lease = await this.options.sessions.acquire(udid)
    } catch (error) {
      log?.warn({ err: error, udid }, 'live view: cannot open the device')
      return
    }
    log?.info({ udid, fps: stream.params.fps }, 'live view started')
    let failures = 0
    try {
      while (!signal.aborted) {
        const started = this.clock.now()
        const period = 1000 / stream.params.fps
        let pause = 0
        try {
          const frame = await capture(lease.driver, stream.params)
          if (signal.aborted) break
          failures = 0
          const sent = await this.options.send(
            protocol.encodeFrame(
              {
                type: 'stream.frame',
                udid,
                seq: stream.seq,
                ts: Date.now(),
                width: frame.width,
                height: frame.height,
                device_width: frame.deviceWidth,
                device_height: frame.deviceHeight,
                rotation: frame.rotation,
                mime: frame.mime,
              },
              frame.image,
            ),
          )
          stream.seq += 1
          // Disconnected: the server has lost this stream and starts it again after the next
          // hello if someone still watches.
          if (!sent) break
          pause = period - (this.clock.now() - started)
        } catch (error) {
          failures += 1
          log?.warn({ err: error, udid, failures }, 'live view: frame failed')
          if (failures >= MAX_FRAME_FAILURES) break
          pause = FAILURE_PAUSE_MS
        }
        if (pause > 0) await this.clock.sleep(pause, signal)
      }
    } catch (error) {
      if (!(error instanceof AbortError)) throw error
    } finally {
      await lease.release()
      log?.info({ udid, frames: stream.seq }, 'live view stopped')
    }
  }
}

/** A frame from the driver; drivers without streamFrame send their PNG screenshot. */
async function capture(
  driver: DeviceDriver & Partial<FrameSource>,
  params: StreamStart,
): Promise<LiveFrame> {
  if (driver.streamFrame) {
    return driver.streamFrame({ maxEdge: params.max_edge, quality: params.quality })
  }
  const [image, screen] = await Promise.all([driver.screenshot(), driver.windowSize()])
  const info = imageInfo(image)
  return {
    image,
    mime: 'image/png',
    width: info?.width ?? screen.width,
    height: info?.height ?? screen.height,
    deviceWidth: screen.width,
    deviceHeight: screen.height,
    rotation: 0,
  }
}
