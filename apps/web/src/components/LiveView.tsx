import { protocol } from '@coral/shared'
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { useCoral } from '../api/queries'
import { en } from '../i18n/en'
import { gesture, toDevice } from './coords'

type StreamState = protocol.UiPayload<'stream.status'>['state'] | 'unavailable'

/** What the page needs to map a click on the frame to the device (US3, research R5). */
export interface FrameInfo {
  width: number
  height: number
  deviceWidth: number
  deviceHeight: number
  rotation: number
}

/** Draws one frame on the canvas; replaced in tests (jsdom has no 2D canvas). */
export type DrawFrame = (canvas: HTMLCanvasElement, frame: protocol.Frame) => Promise<void>

/** Decodes with createImageBitmap (off the main thread) and paints it at the frame's size. */
export const drawFrame: DrawFrame = async (canvas, frame) => {
  const bitmap = await createImageBitmap(
    new Blob([frame.image as Uint8Array<ArrayBuffer>], { type: frame.header.mime }),
  )
  try {
    if (canvas.width !== bitmap.width) canvas.width = bitmap.width
    if (canvas.height !== bitmap.height) canvas.height = bitmap.height
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
  } finally {
    bitmap.close()
  }
}

/**
 * Live view of a device (US2, contracts/ui-ws.md): subscribes over `/ws/ui` while mounted (again
 * after a reconnection), paints each binary frame, and only the newest one — a frame that arrives
 * while another is being decoded replaces the waiting one. Shows the frame rate and an overlay
 * when the stream is starting, stalled or stopped.
 */
export function LiveView({
  deviceId,
  draw = drawFrame,
  onFrameInfo,
  onGesture,
}: {
  deviceId: string
  draw?: DrawFrame
  onFrameInfo?: (info: FrameInfo) => void
  /** Set while the viewer controls the device: clicks, holds and drags become commands (US3). */
  onGesture?: (command: protocol.DeviceCommand) => void
}) {
  const { socket } = useCoral()
  const canvas = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<StreamState>('starting')
  const [reason, setReason] = useState<string | undefined>()
  const [fps, setFps] = useState(0)
  const [size, setSize] = useState<{ width: number; height: number } | undefined>()
  const infoCallback = useRef(onFrameInfo)
  infoCallback.current = onFrameInfo
  // The screen of the frame on display: clicks map with its device size (contracts/ui-ws.md).
  const screen = useRef<FrameInfo | undefined>(undefined)
  const pointer = useRef<{ x: number; y: number; at: number } | undefined>(undefined)

  const at = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, at: event.timeStamp, rect }
  }
  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!onGesture || !screen.current || event.button !== 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    pointer.current = at(event)
  }
  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const down = pointer.current
    pointer.current = undefined
    const current = screen.current
    if (!onGesture || !down || !current) return
    const up = at(event)
    const rendered = { width: up.rect.width, height: up.rect.height }
    onGesture(gesture(down, up, (p) => toDevice(p, rendered, current)))
  }

  useEffect(() => {
    let subscribeId: string | undefined
    let pending: protocol.Frame | undefined
    let drawing = false
    let lastInfo = ''
    const drawn: number[] = []

    const paint = async () => {
      drawing = true
      while (pending && canvas.current) {
        const target = canvas.current
        const frame = pending
        pending = undefined
        try {
          await draw(target, frame)
        } catch {
          continue
        }
        const now = Date.now()
        drawn.push(now)
        // Frames painted so far, for E2E checks (no re-render).
        target.dataset.frames = String(Number(target.dataset.frames ?? 0) + 1)
        while ((drawn[0] ?? now) < now - 1000) drawn.shift()
        setFps(drawn.length)
        const { header } = frame
        const info: FrameInfo = {
          width: header.width,
          height: header.height,
          deviceWidth: header.device_width,
          deviceHeight: header.device_height,
          rotation: header.rotation,
        }
        screen.current = info
        const key = JSON.stringify(info)
        if (key !== lastInfo) {
          lastInfo = key
          setSize({ width: header.width, height: header.height })
          infoCallback.current?.(info)
        }
      }
      drawing = false
    }

    const offBinary = socket.onBinary((bytes) => {
      const decoded = protocol.decodeFrame(bytes)
      if (!decoded.ok || decoded.frame.header.device_id !== deviceId) return
      pending = decoded.frame
      if (!drawing) void paint()
    })
    const offStatus = socket.on('stream.status', (message) => {
      if (message.payload.device_id !== deviceId) return
      setState(message.payload.state)
      setReason(message.payload.reason)
    })
    const offError = socket.on('error', (message) => {
      if (!subscribeId || message.re !== subscribeId) return
      setState('unavailable')
      setReason(message.payload.message)
    })
    const offReady = socket.onReady(() => {
      setState('starting')
      subscribeId = socket.send('stream.subscribe', { device_id: deviceId })
    })
    // The rate falls to 0 when frames stop coming.
    const tick = setInterval(() => {
      const now = Date.now()
      while ((drawn[0] ?? now) < now - 1000) drawn.shift()
      setFps(drawn.length)
    }, 1000)
    socket.connect()
    return () => {
      clearInterval(tick)
      offBinary()
      offStatus()
      offError()
      offReady()
      socket.send('stream.unsubscribe', { device_id: deviceId })
    }
  }, [socket, deviceId, draw])

  const overlay =
    state === 'stalled'
      ? en.live.stalled
      : state === 'stopped'
        ? en.live.stopped
        : state === 'unavailable'
          ? (reason ?? en.live.unavailable)
          : state === 'starting' && !size
            ? en.live.starting
            : undefined

  return (
    <figure className="flex flex-col items-center gap-2">
      <div
        className={`relative overflow-hidden rounded-xl bg-slate-900 shadow-sm ${
          onGesture ? 'ring-2 ring-[#ff7f50] ring-offset-2' : ''
        }`}
        style={
          size ? { aspectRatio: `${size.width} / ${size.height}` } : { aspectRatio: '9 / 19.5' }
        }
      >
        <canvas
          ref={canvas}
          aria-label={en.live.canvas}
          data-testid="live-canvas"
          className={`block h-[70vh] max-h-[760px] w-auto touch-none select-none ${
            onGesture ? 'cursor-crosshair' : ''
          }`}
          // Initial size only: drawFrame sizes the canvas to each frame. React must not set it
          // again, since assigning width or height clears what was painted.
          width={360}
          height={780}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (pointer.current = undefined)}
        />
        {overlay && (
          <div
            role="status"
            className="absolute inset-0 flex items-center justify-center bg-slate-900/70 px-6 text-center text-sm font-medium text-white"
          >
            {overlay}
          </div>
        )}
      </div>
      <figcaption className="flex items-center gap-2 text-xs text-slate-500">
        <span
          aria-hidden
          className={`h-2 w-2 rounded-full ${state === 'live' ? 'bg-emerald-500' : 'bg-slate-400'}`}
        />
        <span data-testid="live-state">{en.live.states[state]}</span>
        <span>·</span>
        <span data-testid="live-fps">{en.live.fps(fps)}</span>
      </figcaption>
    </figure>
  )
}
